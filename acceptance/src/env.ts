/**
 * The environment every acceptance run shares: a throwaway database at
 * `.pglite/accept`, an empty `.mail/` outbox, and every provider forced to its
 * fake. Acceptance must never touch the developer's dev database or a real
 * provider, and must never need a key (Rule B9).
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Db, findRepoRoot } from "@jetpack/db";

export const REPO_ROOT = findRepoRoot();
export const WEB_DIR = join(REPO_ROOT, "apps", "web");
export const FEATURES_DIR = join(WEB_DIR, "src", "features");
const ACCEPT_DATA_DIR = join(REPO_ROOT, ".pglite", "accept");
export const MAIL_DIR = join(REPO_ROOT, ".mail");

/**
 * The port the `route` clause boots Next on. Kept clear of dev (3000) and E2E
 * (3100), and overridable because the kit is cloned per product: two checkouts
 * on one machine would otherwise fight over the same port, and the loser waits
 * out a two-minute timeout to be told nothing.
 */
export const ACCEPT_PORT = Number(process.env.ACCEPT_PORT ?? 3200);
export const ACCEPT_BASE_URL = `http://localhost:${ACCEPT_PORT}`;

/** Env every acceptance child process inherits: fake everything, own database. */
export function acceptEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGLITE_DATA_DIR: ACCEPT_DATA_DIR,
    /**
     * A fixed secret, for the same reason every provider is forced to a fake:
     * an acceptance run must not depend on what the operator happens to have.
     * Inheriting it worked on a laptop with a populated `.env` and failed on a
     * clean CI runner, where Better Auth refused the default and every sign-in
     * returned 500 - so `route` clauses failed for a reason with nothing to do
     * with the product. Not a credential: this database is thrown away.
     */
    BETTER_AUTH_SECRET: "z2h-acceptance-secret-not-a-credential",
    BETTER_AUTH_URL: ACCEPT_BASE_URL,
    NEXT_PUBLIC_SITE_URL: ACCEPT_BASE_URL,
    /**
     * Embedded PGlite by default, and a real Postgres when one is offered
     * explicitly through `ACCEPT_DATABASE_URL`.
     *
     * The developer's own `DATABASE_URL` is still ignored — that is the point of
     * forcing it, and an acceptance run must never touch a real database by
     * accident. But embedded PGlite cannot survive this server: `next dev`
     * evaluates server modules in several isolated module realms, so `db.ts`
     * holds no process-wide singleton and three or four PGlite instances open
     * the same directory. PGlite detects the multi-writer and aborts
     * (`RuntimeError: Aborted()`), after which every write returns 500 —
     * intermittently on a laptop, reliably on a CI runner, where it failed every
     * `route` clause for a reason that had nothing to do with the product.
     * See `guide/KNOWN-ISSUES.md`.
     *
     * A verifier can hand us a throwaway Postgres; opting in by a separate
     * variable keeps the safety property while removing the hazard.
     */
    DATABASE_URL: process.env.ACCEPT_DATABASE_URL ?? "",
    RESEND_API_KEY: "",
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    STRIPE_SECRET_KEY: "",
    // The AI providers too: an acceptance run must never spend money or need a
    // network, so the LLM and the embedder are always the deterministic fakes.
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    AI_MODEL: "fake",
    EMBEDDING_MODEL: "fake",
    // MULTI_TENANT is deliberately NOT set here. It used to be forced on, which
    // meant acceptance proved a configuration no fresh clone ran. It now
    // defaults to true in `lib/config.ts`, so leaving it alone is what makes the
    // suite exercise the shipped default rather than an override of it.
  };
}

/**
 * Absolute path to a CLI binary. pnpm puts a package's bins in the `.bin` of the
 * workspace that depends on it, so `next`/`vitest` live under `apps/web` while
 * `tsx`/`playwright`/`drizzle-kit` live at the root. Look in both.
 */
export function bin(name: string): string {
  const candidates = [
    join(REPO_ROOT, "node_modules", ".bin", name),
    join(WEB_DIR, "node_modules", ".bin", name),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    throw new Error(
      `accept: could not find the "${name}" binary in ${candidates.join(" or ")}. Run \`pnpm install\`.`,
    );
  }
  return found;
}

let prepared = false;

/**
 * Create the acceptance database from the real migration files (never
 * `pushSchema` — the `migration` clause exists precisely to prove the migrations
 * are correct). Runs at most once per `pnpm accept` invocation.
 */
function prepareAcceptDb(): void {
  if (prepared) return;
  rmSync(ACCEPT_DATA_DIR, { recursive: true, force: true });
  rmSync(MAIL_DIR, { recursive: true, force: true });

  execFileSync(bin("tsx"), ["packages/db/src/migrate.ts"], {
    cwd: REPO_ROOT,
    env: acceptEnv(),
    stdio: "pipe",
  });

  if (!existsSync(ACCEPT_DATA_DIR)) {
    throw new Error(
      `accept: migrate did not create ${ACCEPT_DATA_DIR}. Run \`pnpm db:generate\` if a slice has no migration yet.`,
    );
  }
  prepared = true;
}

// ── the one database handle ───────────────────────────────────────────────────

let handle: { db: Db; close: () => Promise<void> } | undefined;

/**
 * The CLI's database handle, opened once and shared by every clause that talks
 * to the database directly.
 *
 * Embedded PGlite is a single-writer engine: two instances over one data
 * directory abort each other's WASM runtime (`Aborted()`), and that is true
 * across processes as well as within one. So the runner keeps exactly one owner
 * at a time — this handle while the db clauses run, then `closeAcceptDb()`
 * before the Next server that serves the `route` clauses is allowed to open it.
 */
export function acceptDb(): Db {
  prepareAcceptDb();
  handle ??= createClient({ databaseUrl: "", pgliteDataDir: ACCEPT_DATA_DIR });
  return handle.db;
}

/** Release the database so another process can own it. Safe to call twice. */
export async function closeAcceptDb(): Promise<void> {
  const open = handle;
  handle = undefined;
  await open?.close();
}
