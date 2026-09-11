/**
 * Rendering. The table is what a human reads; `--json` is what the MCP `verify`
 * tool and the unattended runner read. Every failure line names the clause, the
 * expectation, and file:line where we have one (Rule B10).
 */
import type { AcceptRunResult, ClauseResult, Failure } from "./types";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
} as const;

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function ms(value: number): string {
  return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`;
}

function location(failure: Failure): string {
  if (!failure.file) return "";
  return failure.line ? `${failure.file}:${failure.line}` : failure.file;
}

function clauseLine(clause: ClauseResult, labelWidth: number): string[] {
  const dot = clause.ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
  const lines = [
    `  ${dot} ${pad(clause.label, labelWidth)} ${clause.summary} ${C.dim}(${ms(clause.ms)})${C.reset}`,
  ];
  for (const failure of clause.failures) {
    const where = location(failure);
    lines.push(
      `      ${C.red}→${C.reset} ${where ? `${C.bold}${where}${C.reset} — ` : ""}${failure.message}`,
    );
  }
  return lines;
}

export function renderTable(run: AcceptRunResult): string {
  const lines: string[] = [];
  const labelWidth = Math.max(
    12,
    ...run.specs.flatMap((s) => s.clauses.map((c) => c.label.length)),
  );

  for (const spec of run.specs) {
    const mark = spec.ok ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
    lines.push("");
    lines.push(
      `${C.bold}accept ${spec.feature}${C.reset}  ${mark}  ${C.dim}${ms(spec.ms)}${C.reset}`,
    );
    for (const clause of spec.clauses) lines.push(...clauseLine(clause, labelWidth));
  }

  const passed = run.specs.filter((s) => s.ok).length;
  const colour = run.ok ? C.green : C.red;
  const glyph = run.ok ? "✓" : "✗";
  lines.push("");
  lines.push(
    `${colour}${C.bold}${glyph} accept: ${passed}/${run.specs.length} feature(s) green${C.reset} ${C.dim}(${ms(run.ms)})${C.reset}`,
  );
  return lines.join("\n");
}

/** One actionable sentence, for the MCP envelope and `.jetpack/last-run.json`. */
export function summarize(run: AcceptRunResult): string {
  const failing = run.specs.filter((s) => !s.ok);
  if (failing.length === 0) {
    const names = run.specs.map((s) => s.feature).join(", ");
    return `accept green: ${names || "no features have an accept spec yet"}`;
  }
  const clause = failing[0]?.clauses.find((c) => !c.ok);
  const names = failing.map((s) => s.feature).join(", ");
  return `accept failed for ${names} — ${clause?.label ?? "unknown clause"}: ${clause?.summary ?? "see the report"}`;
}
