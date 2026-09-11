/**
 * `e2e` clause — the named Playwright spec passes. Playwright owns its own
 * server and database (see playwright.config.ts), so this clause just runs it
 * and lifts the first failing assertion out of the JSON reporter.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { bin, REPO_ROOT } from "../env";
import type { ClauseResult, Failure } from "../types";

interface PlaywrightError {
  message?: string;
  location?: { file?: string; line?: number };
}
interface PlaywrightSpec {
  title: string;
  ok: boolean;
  tests?: Array<{ results?: Array<{ error?: PlaywrightError }> }>;
}
interface PlaywrightSuite {
  suites?: PlaywrightSuite[];
  specs?: PlaywrightSpec[];
}
interface PlaywrightJson {
  stats?: { expected?: number; unexpected?: number };
  errors?: Array<{ message?: string }>;
  suites?: PlaywrightSuite[];
}

function collectSpecs(suites: PlaywrightSuite[] | undefined): PlaywrightSpec[] {
  const out: PlaywrightSpec[] = [];
  for (const suite of suites ?? []) {
    out.push(...(suite.specs ?? []));
    out.push(...collectSpecs(suite.suites));
  }
  return out;
}

export async function runE2eClause(spec: string): Promise<ClauseResult> {
  const started = Date.now();
  const failures: Failure[] = [];

  if (!existsSync(join(REPO_ROOT, spec))) {
    return finish(started, spec, `the Playwright spec ${spec} does not exist`, [
      {
        file: spec,
        message:
          "expected the Playwright spec to exist; it does not. The accept spec's e2e path is relative to the repo root.",
      },
    ]);
  }

  const reportFile = join(REPO_ROOT, ".jetpack", "accept-e2e.json");
  rmSync(reportFile, { force: true });
  try {
    execFileSync(bin("playwright"), ["test", spec, "--reporter=json"], {
      cwd: REPO_ROOT,
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      // A stuck browser or web server must fail the clause, not hang the run.
      timeout: 15 * 60_000,
    });
  } catch {
    // A non-zero exit means test failures; they are read from the report below.
  }

  const report = readReport(reportFile);
  if (!report) {
    return finish(started, spec, "playwright produced no parseable report", [
      {
        file: spec,
        message: `could not read Playwright's JSON report. Run \`pnpm test:e2e ${spec}\` to see the real output.`,
      },
    ]);
  }

  for (const error of report.errors ?? []) {
    failures.push({ file: spec, message: error.message ?? "Playwright reported an error." });
  }
  for (const failing of collectSpecs(report.suites).filter((s) => !s.ok)) {
    const error = failing.tests?.[0]?.results?.[0]?.error;
    const file = error?.location?.file;
    const line = error?.location?.line;
    failures.push({
      file: file ? relToRepo(file) : spec,
      ...(line ? { line } : {}),
      message: `expected "${failing.title}" to pass. ${firstLine(error?.message) || "See the Playwright report."}`,
    });
  }

  const passed = report.stats?.expected ?? 0;
  const failed = report.stats?.unexpected ?? 0;
  const summary =
    failures.length === 0
      ? `${passed} Playwright test(s) passed in ${spec}`
      : `${failed} Playwright test(s) failed in ${spec}`;
  return finish(started, spec, summary, failures);
}

function readReport(file: string): PlaywrightJson | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as PlaywrightJson;
  } catch {
    return undefined;
  }
}

function relToRepo(file: string): string {
  return file.startsWith(REPO_ROOT) ? file.slice(REPO_ROOT.length + 1) : file;
}

/** Playwright colours its messages; strip the escapes so failures stay readable. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function firstLine(message: string | undefined): string {
  if (!message) return "";
  return message.replace(ANSI, "").split("\n")[0] ?? "";
}

function finish(started: number, spec: string, summary: string, failures: Failure[]): ClauseResult {
  return {
    clause: "e2e",
    label: `e2e: ${spec}`,
    ok: failures.length === 0,
    summary,
    ms: Date.now() - started,
    failures,
  };
}
