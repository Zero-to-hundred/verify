/**
 * `pnpm accept <feature> [--json]` and `pnpm accept:all [--json]`.
 *
 * Exit code 0 only when every clause of every requested feature passed. Also
 * writes `.jetpack/last-run.json` so the Launchpad and `pnpm run doctor` can show the
 * last acceptance result without re-running anything.
 */
import { recordRun } from "@jetpack/doctor";
import { closeAcceptDb } from "./env";
import { acquireAcceptLock } from "./lock";
import { renderTable, summarize } from "./report";
import { discoverFeatures, runFeatures } from "./runner";
import { serverOutput, stopServer } from "./server";
import type { AcceptRunResult } from "./types";

const USAGE = `Usage:
  pnpm accept <feature> [--json]     run one slice's acceptance spec
  pnpm accept:all [--json]           run every slice that has an accept.ts

A feature is done when its accept spec is green. Never weaken a clause to pass.`;

/** Record the result for the Launchpad, `pnpm run doctor`, and project_status. */
function writeLastRun(run: AcceptRunResult, all: boolean): void {
  const record = {
    ok: run.ok,
    ranAt: run.ranAt,
    summary: summarize(run),
    features: run.specs.map((s) => ({ feature: s.feature, ok: s.ok })),
  };
  recordRun(all ? { accept: record, acceptAll: record } : { accept: record });
}

let releaseLock: (() => void) | undefined;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const all = args.includes("--all");
  const named = args.filter((a) => !a.startsWith("--"));

  if (!all && named.length === 0) {
    console.error(USAGE);
    process.exit(2);
  }

  // Fail fast rather than letting two runs abort each other's database.
  releaseLock = acquireAcceptLock();

  const features = all ? discoverFeatures() : named;
  if (features.length === 0) {
    const message = all
      ? "accept: no slice has an accept.ts yet. `pnpm gen:feature <name>` stamps one."
      : "accept: no feature named.";
    if (json) console.log(JSON.stringify({ ok: true, summary: message, specs: [] }, null, 2));
    else console.log(message);
    return;
  }

  const run = await runFeatures(features);
  writeLastRun(run, all);

  if (json) console.log(JSON.stringify({ ...run, summary: summarize(run) }, null, 2));
  else console.log(renderTable(run));

  if (!run.ok) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify({ ok: false, summary: message, specs: [] }, null, 2));
    } else {
      console.error(message);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    /**
     * When a run fails, print what the app said.
     *
     * A clause reports the status it got — `POST /api/auth/sign-in returned
     * 500` — and the reason lives in the server's stack trace, which nothing
     * was showing. Silent on success, because a passing run does not need a
     * page of Next output.
     */
    if (process.exitCode === 1 && !process.argv.includes("--json")) {
      const output = serverOutput();
      if (output) {
        console.error(`\n─── the app's output during this run ───\n${output}\n`);
      }
    }

    stopServer();
    await closeAcceptDb();
    releaseLock?.();
    // Exit explicitly. A leaked child handle or an open WASM database must not
    // be able to hold the CLI open after the report is written — a run that has
    // printed its verdict but never exits looks exactly like a hung one, and
    // that has already cost debugging time.
    process.exit(process.exitCode ?? 0);
  });
