/**
 * The Next server the `route` clause talks to: booted once per `pnpm accept`
 * invocation against the acceptance database, reused by every clause, and shut
 * down at the end. Signing in goes through the real magic-link flow and reads
 * the link out of `.mail/` — the same path a buyer's first sign-in takes.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ACCEPT_BASE_URL, ACCEPT_PORT, acceptEnv, bin, MAIL_DIR, REPO_ROOT } from "./env";

/**
 * The last few KB of what the child printed.
 *
 * The runner used to `.resume()` stdout and stderr, which drains them and drops
 * every byte. When a boot fails, those bytes are the entire diagnosis — Next
 * refusing a second dev server for the same project directory says so in one
 * line — and without them every `route` and `e2e` clause in the kit fails at
 * once with a message that names no cause.
 *
 * The end rather than the beginning: a boot failure is the last thing said.
 */
export function createOutputTail(maxBytes = 8_000): {
  push: (chunk: string) => void;
  text: () => string;
} {
  let buffered = "";
  return {
    push(chunk) {
      buffered = (buffered + chunk).slice(-maxBytes);
    },
    text() {
      return buffered.trimEnd();
    },
  };
}

/** How the child ended, when it ended before the server answered. */
export interface ServerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * The message a failed boot throws. It exists to answer "why", which the old
 * one never did.
 */
export function readinessError(opts: {
  url: string;
  timeoutMs: number;
  output: string;
  exit?: ServerExit | undefined;
}): string {
  const { url, timeoutMs, output, exit } = opts;

  const headline = exit
    ? `accept: the test server exited before answering on ${url} (code ${exit.code}, signal ${exit.signal}).`
    : `accept: the test server did not become ready on ${url} within ${timeoutMs / 1000}s.`;

  const body = output
    ? `\n\nWhat it printed:\n\n${output}`
    : "\n\nIt printed no output at all, which usually means it never started — check the spawn, not the app.";

  return headline + body;
}

/**
 * Whether to adopt a server this run did not start.
 *
 * A port cannot say what booted it. Adopting whatever answers meant a detached
 * child from an earlier run — booted with a different `MULTI_TENANT`, say — was
 * taken as the acceptance server, and every slice then ran against the wrong
 * app and blamed the product. So the default is to refuse, and adopting one is
 * something you say on purpose.
 */
export function adoptsForeignServer(env: NodeJS.ProcessEnv): boolean {
  return (env.ACCEPT_REUSE_SERVER ?? "").trim() !== "";
}

/** Refusing has to say what to do about it, or it is just a different failure. */
export function foreignServerError(url: string, port: number): string {
  return [
    `accept: something is already listening on ${url}, and this run did not start it.`,
    "",
    "A port cannot say what booted it, so adopting it risks running every slice",
    "against an app configured differently from this run — which fails as a",
    "product bug rather than an environment one. Three ways forward:",
    "",
    `  · stop the other process:  lsof -ti :${port} | xargs kill`,
    `  · run beside it:           ACCEPT_PORT=${port + 1} pnpm accept …`,
    "  · adopt it deliberately:   ACCEPT_REUSE_SERVER=1 pnpm accept …",
  ].join("\n");
}

let server: ChildProcess | undefined;
/**
 * The server's recent output, kept for the whole run rather than only for the
 * boot.
 *
 * A boot failure was already diagnosable; a *runtime* failure was not. A clause
 * that got `500` from the app reported the status and nothing else, because the
 * server's stack trace went into a buffer nobody read — which is the same bug as
 * `.resume()` discarding it, one step further in. `serverOutput()` is what the
 * reporter prints when a run fails.
 */
let serverTail: { push: (chunk: string) => void; text: () => string } | undefined;
let booting: Promise<void> | undefined;

async function isUp(): Promise<boolean> {
  try {
    const res = await fetch(ACCEPT_BASE_URL, { signal: AbortSignal.timeout(1500) });
    return res.status > 0;
  } catch {
    return false;
  }
}

async function waitForReady(
  timeoutMs: number,
  tail: { text: () => string },
  exited: () => ServerExit | undefined,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUp()) return;
    // A child that has already died will never answer. Waiting out the full
    // two minutes to say so wastes the run and buries the reason.
    const exit = exited();
    if (exit) {
      throw new Error(
        readinessError({ url: ACCEPT_BASE_URL, timeoutMs, output: tail.text(), exit }),
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(readinessError({ url: ACCEPT_BASE_URL, timeoutMs, output: tail.text() }));
}

/** Boot (or reuse) the acceptance server. Safe to call from every clause. */
export async function ensureServer(): Promise<void> {
  booting ??= (async () => {
    if (await isUp()) {
      // Something answers. It is not ours — this closure runs once per process,
      // before we spawn anything — so it is only safe if we are told it is.
      if (adoptsForeignServer(process.env)) return;
      throw new Error(foreignServerError(ACCEPT_BASE_URL, ACCEPT_PORT));
    }
    server = spawn(bin("next"), ["dev", "--port", String(ACCEPT_PORT)], {
      cwd: join(REPO_ROOT, "apps", "web"),
      env: acceptEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so stopServer() can kill the whole tree. `next
      // dev` forks a next-server worker; killing only the parent leaves that
      // worker holding port 3200 and apps/web/.next.
      detached: true,
    });
    // Read both streams rather than draining them: an unread pipe fills and
    // blocks the child, and the bytes are the diagnosis when a boot fails.
    const tail = createOutputTail(20_000);
    serverTail = tail;
    server.stdout?.setEncoding("utf8");
    server.stderr?.setEncoding("utf8");
    server.stdout?.on("data", (chunk: string) => tail.push(chunk));
    server.stderr?.on("data", (chunk: string) => tail.push(chunk));

    let exit: ServerExit | undefined;
    server.on("exit", (code, signal) => {
      exit = { code, signal };
    });

    // Do not let the child keep our event loop alive.
    server.unref();
    await waitForReady(120_000, tail, () => exit);
  })();
  return booting;
}

/** What the app printed while the clauses ran. Empty when nothing was captured. */
export function serverOutput(): string {
  return serverTail?.text() ?? "";
}

export function stopServer(): void {
  const child = server;
  server = undefined;
  booting = undefined;
  if (!child?.pid) return;
  try {
    // Negative pid = the whole process group (see `detached` above).
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already gone, or no group — fall back to the single process.
    try {
      child.kill("SIGTERM");
    } catch {
      // Nothing left to kill.
    }
  }
}

/** The most recent FileMailer message for `to`. */
function latestMailTo(to: string): { text: string } {
  const slug = to.replace(/[^a-zA-Z0-9._-]/g, "_");
  const names = readdirSync(MAIL_DIR).filter((n) => n.endsWith(`-${slug}.json`));
  const newest = names.sort().pop();
  if (!newest) {
    throw new Error(
      `accept: no .mail/ message for ${to}. The FileMailer should have written the magic link — is RESEND_API_KEY leaking into the acceptance environment?`,
    );
  }
  return JSON.parse(readFileSync(join(MAIL_DIR, newest), "utf8")) as { text: string };
}

function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

/**
 * Sign a brand-new user in through the magic-link flow and return their session
 * cookie header.
 */
export async function signInFreshUser(): Promise<string> {
  const email = `accept-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

  const requested = await fetch(`${ACCEPT_BASE_URL}/api/auth/sign-in/magic-link`, {
    method: "POST",
    // Better Auth rejects a state-changing request with no Origin (CSRF). A real
    // browser always sends one, so send the one the server trusts.
    headers: { "content-type": "application/json", origin: ACCEPT_BASE_URL },
    body: JSON.stringify({ email, callbackURL: "/dashboard" }),
  });
  if (!requested.ok) {
    throw new Error(
      `accept: POST /api/auth/sign-in/magic-link returned ${requested.status}; expected 200. Body: ${await requested.text()}`,
    );
  }

  const link = latestMailTo(email).text.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error(`accept: the magic-link email to ${email} contained no URL.`);

  const verified = await fetch(link, { redirect: "manual" });
  const cookie = cookiesFrom(verified);
  if (!cookie) {
    throw new Error(
      `accept: following the magic link returned ${verified.status} with no session cookie; expected a 302 that sets one.`,
    );
  }
  /**
   * Past the onboarding gate.
   *
   * The app shell holds a brand-new user at `/onboarding`, so without this every
   * `route` clause in every slice would assert a redirect that has nothing to do
   * with what it is testing. This is the same endpoint the onboarding flow's own
   * Finish button posts to, not a test-only door, and it is idempotent.
   */
  const finished = await fetch(`${ACCEPT_BASE_URL}/api/onboarding/finish`, {
    method: "POST",
    headers: { cookie, origin: ACCEPT_BASE_URL },
    redirect: "manual",
  });
  if (finished.status !== 303) {
    throw new Error(
      `accept: POST /api/onboarding/finish returned ${finished.status}; expected 303. Body: ${await finished.text()}`,
    );
  }

  return cookie;
}
