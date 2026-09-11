/**
 * One `accept` per repository at a time.
 *
 * The acceptance database is embedded PGlite, which is single-writer *across
 * processes*: two runs over `.pglite/accept` abort each other's WASM runtime
 * with a bare `Aborted()`, and the loser's JSON output is unparseable. That has
 * already cost one gate run a false red — a second-terminal watcher loop calling
 * `pnpm accept` every 20s collided with the run's own final verification, and
 * the run was scored red even though the slice was green.
 *
 * So take a lock and fail fast with a sentence that says what is happening,
 * instead of letting the two runs corrupt each other's results.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./env";

const LOCK_FILE = join(REPO_ROOT, ".jetpack", "accept.lock");

interface LockContents {
  pid: number;
  startedAt: string;
  argv: string;
}

function read(): LockContents | null {
  try {
    return JSON.parse(readFileSync(LOCK_FILE, "utf8")) as LockContents;
  } catch {
    return null;
  }
}

/** Whether a process is still alive. `kill(pid, 0)` only tests, it does not signal. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Take the lock, or throw with an actionable message. Returns a release
 * function; it is safe to call more than once.
 */
export function acquireAcceptLock(): () => void {
  if (existsSync(LOCK_FILE)) {
    const held = read();
    if (held && alive(held.pid)) {
      throw new Error(
        [
          `accept: another acceptance run is already going in this repository (pid ${held.pid}, started ${held.startedAt}).`,
          `  It was: ${held.argv}`,
          "",
          "  Run only one `accept` at a time. The acceptance database is embedded PGlite,",
          "  which is single-writer across processes — two runs abort each other and the",
          "  loser reports a failure that never happened.",
          "",
          "  Watching a run go green? Watch the files appear (`ls apps/web/src/features/<slice>`),",
          "  never a second `accept` loop.",
          "",
          `  If that process is gone, delete .jetpack/accept.lock and try again.`,
        ].join("\n"),
      );
    }
    // Stale: the holder died without releasing.
    rmSync(LOCK_FILE, { force: true });
  }

  mkdirSync(join(LOCK_FILE, ".."), { recursive: true });
  const contents: LockContents = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    argv: `pnpm accept ${process.argv.slice(2).join(" ")}`.trim(),
  };
  writeFileSync(LOCK_FILE, `${JSON.stringify(contents, null, 2)}\n`, "utf8");

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    // Only remove our own lock — never someone else's.
    if (read()?.pid === process.pid) rmSync(LOCK_FILE, { force: true });
  };

  // A killed run must not leave the lock behind for the next one.
  process.once("exit", release);
  process.once("SIGINT", () => {
    release();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    release();
    process.exit(143);
  });

  return release;
}
