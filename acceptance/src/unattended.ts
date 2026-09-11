/**
 * `pnpm accept:unattended <prompt-file> [--kit <path>] [--runs N] [--feature <name>]`
 *
 * The gate harness. For each run: clone the kit into a throwaway directory,
 * `pnpm install && pnpm run setup`, hand the prompt to Claude Code headless, and
 * then — **independently, in the clone, never trusting the agent's own claim** —
 * run `pnpm accept <feature>` ourselves. The verdict in the report is that run,
 * not anything the agent said.
 *
 * Rule B11: if a run fails, the fix goes in the product, the generator, the
 * skill, or AGENTS.md. Never in the prompt and never in the spec.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { parsePrompt } from "../benchmark/expectation";
import { REPO_ROOT } from "./env";
import { parseStream, type StreamStats } from "./stream";

/**
 * The exact headless invocation, as a constant (Part G: `claude -p` flags move).
 * Verified against Claude Code **2.1.247**:
 *  - `--max-turns` no longer exists; `--max-budget-usd` is the current cap.
 *  - `--permission-mode bypassPermissions` is what allows unattended tool use.
 *    Safe here because every run happens in a throwaway clone under the OS temp
 *    directory with no access to anything else.
 *  - `--strict-mcp-config` with `--mcp-config .mcp.json` guarantees the run sees
 *    the kit's own MCP servers and none of the operator's.
 */
const CLAUDE_ARGS = (promptFile: string, budgetUsd: number): string[] => [
  "-p",
  // `parsePrompt` strips the fenced ```accept block: it is the harness's
  // expectation, and handing it to the agent would be giving it the answer key.
  parsePrompt(readFileSync(promptFile, "utf8")).words,
  "--output-format",
  "stream-json",
  "--verbose",
  "--permission-mode",
  "bypassPermissions",
  "--mcp-config",
  ".mcp.json",
  "--strict-mcp-config",
  "--max-budget-usd",
  String(budgetUsd),
];

const DEFAULT_BUDGET_USD = 12;

interface Options {
  promptFile: string;
  kit: string;
  runs: number;
  feature: string;
  budgetUsd: number;
  /** Keep each clone's node_modules (~600 MB per run). Off by default. */
  keepClones: boolean;
}

export interface RunOutcome {
  run: number;
  kit: string;
  prompt: string;
  /** OUR independent verdict, from running the acceptance spec in the clone. */
  accepted: boolean;
  acceptSummary: string;
  turns: number;
  toolCalls: number;
  verifyAttempts: number;
  acceptAttempts: number;
  /** 1-based index of the first accept attempt the agent saw come back green. */
  firstGreenAttempt: number | null;
  wallClockMs: number;
  interventions: number;
  costUsd: number | null;
  log: string;
  error: string | null;
}

function usage(): never {
  console.error(
    `Usage: pnpm accept:unattended <prompt-file> [--kit <path>] [--runs N] [--feature <name>] [--budget-usd N] [--keep-clones]

Runs the prompt against a fresh clone of the kit N times and verifies each run
independently with \`pnpm accept <feature>\`. The feature defaults to the second
dash-separated segment of the prompt filename (p01-workspaces-usage-limit.md ->
workspaces).`,
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const promptArg = positional[0];
  if (!promptArg) usage();
  const promptFile = resolve(REPO_ROOT, promptArg);
  if (!existsSync(promptFile)) {
    console.error(`No prompt file at ${promptFile}`);
    process.exit(2);
  }
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const fromName = basename(promptFile).replace(/\.md$/, "").split("-")[1];
  const feature = flag("feature") ?? fromName;
  if (!feature) usage();

  return {
    promptFile,
    kit: resolve(flag("kit") ?? REPO_ROOT),
    runs: Number(flag("runs") ?? 1),
    feature,
    budgetUsd: Number(flag("budget-usd") ?? DEFAULT_BUDGET_USD),
    keepClones: argv.includes("--keep-clones"),
  };
}

function sh(command: string, args: string[], cwd: string, timeoutMs = 20 * 60_000): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", timeout: timeoutMs });
  if (result.status !== 0) {
    throw new Error(`\`${command} ${args.join(" ")}\` failed in ${cwd} (exit ${result.status}).`);
  }
}

/** A fresh clone of the kit at its current HEAD, with a working tree. */
function cloneKit(kit: string, into: string): void {
  execFileSync("git", ["clone", "--quiet", "--depth", "1", `file://${kit}`, into], {
    stdio: "inherit",
  });
  // `.env` and `.mcp.json` matter to the run; `.env` is git-ignored, so seed it.
  const env = join(kit, ".env.example");
  if (existsSync(env)) writeFileSync(join(into, ".env"), readFileSync(env, "utf8"));
}

function acceptInClone(clone: string, feature: string): { ok: boolean; summary: string } {
  const result = spawnSync("pnpm", ["run", "accept", feature, "--json"], {
    cwd: clone,
    encoding: "utf8",
    timeout: 20 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = result.stdout ?? "";
  try {
    const parsed = JSON.parse(out.slice(out.indexOf("{"))) as { ok?: boolean; summary?: string };
    return { ok: parsed.ok === true, summary: parsed.summary ?? "accept produced no summary" };
  } catch {
    return {
      ok: false,
      summary: `accept ${feature} produced no parseable JSON (exit ${result.status}). ${(result.stderr ?? "").split("\n")[0] ?? ""}`,
    };
  }
}

function summarizeAttempts(stats: StreamStats): {
  verifyAttempts: number;
  acceptAttempts: number;
  firstGreenAttempt: number | null;
} {
  const accepts = stats.attempts.filter((a) => a.kind === "accept");
  const greenIndex = accepts.findIndex((a) => a.ok === true);
  return {
    verifyAttempts: stats.attempts.filter((a) => a.kind === "verify").length,
    acceptAttempts: accepts.length,
    firstGreenAttempt: greenIndex === -1 ? null : greenIndex + 1,
  };
}

function runOnce(opts: Options, run: number, runDir: string): RunOutcome {
  const clone = join(runDir, `clone-${run}`);
  const logFile = join(runDir, `${run}.jsonl`);
  const started = Date.now();

  console.log(`\n── run ${run}/${opts.runs} ─────────────────────────────────────────`);
  console.log(`clone → ${clone}`);
  cloneKit(opts.kit, clone);
  sh("pnpm", ["install", "--prefer-offline"], clone);
  sh("pnpm", ["run", "setup"], clone);

  console.log(`\nclaude -p "$(cat ${basename(opts.promptFile)})" … (streaming to ${run}.jsonl)\n`);
  const claude = spawnSync("claude", CLAUDE_ARGS(opts.promptFile, opts.budgetUsd), {
    cwd: clone,
    encoding: "utf8",
    timeout: 60 * 60_000,
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, JETPACK_NONINTERACTIVE: "1" },
  });
  const jsonl = claude.stdout ?? "";
  writeFileSync(logFile, jsonl);
  if (claude.stderr) appendFileSync(join(runDir, `${run}.stderr.log`), claude.stderr);

  const stats = parseStream(jsonl);
  const wallClockMs = Date.now() - started;

  // Independent verification. Never trust the agent's own claim.
  console.log(`\nverifying independently: pnpm accept ${opts.feature}`);
  const verdict = acceptInClone(clone, opts.feature);
  console.log(`  → ${verdict.ok ? "GREEN" : "RED"}: ${verdict.summary}`);

  // The source tree stays for inspection; node_modules is ~600 MB per run.
  if (!opts.keepClones) rmSync(join(clone, "node_modules"), { recursive: true, force: true });

  return {
    run,
    kit: basename(opts.kit),
    prompt: basename(opts.promptFile),
    accepted: verdict.ok,
    acceptSummary: verdict.summary,
    turns: stats.turns,
    toolCalls: Object.values(stats.toolCalls).reduce((a, b) => a + b, 0),
    ...summarizeAttempts(stats),
    wallClockMs,
    interventions: 0, // headless: there is no human in the loop. Recorded anyway.
    costUsd: stats.costUsd,
    log: `${run}.jsonl`,
    error: stats.error ?? (claude.status === 0 ? null : `claude exited ${claude.status}`),
  };
}

function renderReport(
  opts: Options,
  outcomes: RunOutcome[],
  toolTotals: Record<string, number>,
): string {
  const green = outcomes.filter((o) => o.accepted).length;
  const ms = (v: number): string => `${(v / 1000 / 60).toFixed(1)}m`;
  const lines = [
    `# Unattended run report — ${opts.feature}`,
    "",
    `**${green}/${outcomes.length} green.** Each run is a fresh \`git clone\` of the kit,`,
    `\`pnpm install && pnpm run setup\`, then the prompt below handed to Claude Code`,
    `headless. Every verdict comes from running \`pnpm accept ${opts.feature}\` in the`,
    "clone afterwards — the agent's own claim is never taken as evidence.",
    "",
    `- Prompt: \`${basename(opts.promptFile)}\``,
    `- Kit: \`${opts.kit}\``,
    `- Invocation: \`claude -p … --output-format stream-json --verbose --permission-mode bypassPermissions --mcp-config .mcp.json --strict-mcp-config --max-budget-usd ${opts.budgetUsd}\``,
    "",
    "## Runs",
    "",
    "| run | kit | prompt | result (accept) | turns | tool calls | verify attempts | first-green attempt | wall-clock | interventions | log |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...outcomes.map(
      (o) =>
        `| ${o.run} | ${o.kit} | ${o.prompt} | ${o.accepted ? "✅ green" : "❌ red"} | ${o.turns} | ${o.toolCalls} | ${o.verifyAttempts + o.acceptAttempts} | ${o.firstGreenAttempt ?? "—"} | ${ms(o.wallClockMs)} | ${o.interventions} | \`${o.log}\` |`,
    ),
    "",
    "## Verdicts",
    "",
    ...outcomes.map(
      (o) =>
        `- **run ${o.run}** — ${o.acceptSummary}${o.error ? ` _(runner note: ${o.error})_` : ""}`,
    ),
    "",
    "## Tool calls across all runs",
    "",
    ...Object.entries(toolTotals)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `- \`${name}\` × ${count}`),
    "",
    "## Prompt",
    "",
    "```",
    readFileSync(opts.promptFile, "utf8").trim(),
    "```",
    "",
  ];
  return lines.join("\n");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(REPO_ROOT, "packages", "acceptance", "benchmark", "runs", stamp);
  mkdirSync(runDir, { recursive: true });

  console.log(
    `unattended: ${opts.runs} run(s) of ${basename(opts.promptFile)} → accept ${opts.feature}`,
  );
  console.log(`run directory: ${runDir}`);

  const outcomes: RunOutcome[] = [];
  const toolTotals: Record<string, number> = {};
  for (let run = 1; run <= opts.runs; run += 1) {
    const outcome = runOnce(opts, run, runDir);
    outcomes.push(outcome);
    const stats = parseStream(readFileSync(join(runDir, outcome.log), "utf8"));
    for (const [name, count] of Object.entries(stats.toolCalls)) {
      toolTotals[name] = (toolTotals[name] ?? 0) + count;
    }
    writeFileSync(join(runDir, "outcomes.json"), `${JSON.stringify(outcomes, null, 2)}\n`);
  }

  const report = renderReport(opts, outcomes, toolTotals);
  writeFileSync(join(runDir, "report.md"), report);

  const green = outcomes.filter((o) => o.accepted).length;
  console.log(`\n${green}/${outcomes.length} green. Report: ${join(runDir, "report.md")}`);
  if (green !== outcomes.length) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
