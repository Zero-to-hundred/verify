/** `custom` clause — the escape hatch: a named assertion the runner awaits. */
import type { ClauseResult, CustomClause } from "../types";

export async function runCustomClause(clause: CustomClause): Promise<ClauseResult> {
  const started = Date.now();
  try {
    await clause.run();
    return {
      clause: "custom",
      label: `custom: ${clause.name}`,
      ok: true,
      summary: clause.name,
      ms: Date.now() - started,
      failures: [],
    };
  } catch (err) {
    return {
      clause: "custom",
      label: `custom: ${clause.name}`,
      ok: false,
      summary: `custom assertion "${clause.name}" failed`,
      ms: Date.now() - started,
      failures: [{ message: err instanceof Error ? err.message : String(err) }],
    };
  }
}
