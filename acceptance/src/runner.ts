/**
 * Discover and run acceptance specs.
 *
 * Clauses are grouped by **who owns the database**, not by feature, because
 * embedded PGlite is a single-writer engine: the CLI's own handle and the Next
 * server the `route` clauses talk to cannot both hold `.pglite/accept` at once.
 * So the whole run goes in three phases —
 *
 *   1. database clauses (migration, service, entitlement, custom) — the CLI owns it
 *   2. `route` clauses — the handle is closed and one Next server owns it
 *   3. `e2e` clauses — the server is stopped; Playwright owns its own database
 *
 * — and the per-feature results are reassembled afterwards in spec order. It is
 * also faster: one server boot for the whole run instead of one per feature.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runCustomClause } from "./clauses/custom";
import { runE2eClause } from "./clauses/e2e";
import { runEntitlementClause } from "./clauses/entitlement";
import { runMigrationClause } from "./clauses/migration";
import { runRouteClause } from "./clauses/route";
import { runServiceClause } from "./clauses/service";
import { closeAcceptDb, FEATURES_DIR } from "./env";
import { stopServer } from "./server";
import type { AcceptanceSpec, AcceptRunResult, ClauseResult, SpecResult } from "./types";

/** Every slice that ships an `accept.ts`. */
export function discoverFeatures(): string[] {
  if (!existsSync(FEATURES_DIR)) return [];
  return readdirSync(FEATURES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(FEATURES_DIR, e.name, "accept.ts")))
    .map((e) => e.name)
    .sort();
}

async function loadSpec(feature: string): Promise<AcceptanceSpec> {
  const file = join(FEATURES_DIR, feature, "accept.ts");
  if (!existsSync(file)) {
    throw new Error(
      `accept: no acceptance spec at apps/web/src/features/${feature}/accept.ts. Run \`pnpm gen:feature ${feature}\` to stamp one, or check the slice name.`,
    );
  }
  const mod = (await import(pathToFileURL(file).href)) as { default?: AcceptanceSpec };
  const spec = mod.default;
  if (!spec || typeof spec.name !== "string" || !spec.clauses) {
    throw new Error(
      `accept: apps/web/src/features/${feature}/accept.ts must default-export acceptance("${feature}", { ... }).`,
    );
  }
  if (spec.name !== feature) {
    throw new Error(
      `accept: apps/web/src/features/${feature}/accept.ts declares acceptance("${spec.name}", ...); expected "${feature}" so the CLI and the directory agree.`,
    );
  }
  return spec;
}

const EMPTY_SPEC = (feature: string): ClauseResult => ({
  clause: "custom",
  label: "spec",
  ok: false,
  summary: "the acceptance spec declares no clauses, so nothing can be proven",
  ms: 0,
  failures: [
    {
      file: `apps/web/src/features/${feature}/accept.ts`,
      message:
        "expected at least one clause (migration / service / route / entitlement / e2e / custom); the spec is empty.",
    },
  ],
});

export async function runFeatures(features: string[]): Promise<AcceptRunResult> {
  const started = Date.now();
  const specs: AcceptanceSpec[] = [];
  for (const feature of features) specs.push(await loadSpec(feature));

  const results = new Map<string, ClauseResult[]>(specs.map((s) => [s.name, []]));
  /**
   * Record a clause and report it on **stderr** as it lands. stdout is the
   * report (and `--json`), so progress cannot go there — but a run with no
   * output for minutes is indistinguishable from a hung one, and this harness
   * has already been mistaken for hung once.
   */
  const add = (feature: string, result: ClauseResult): void => {
    results.get(feature)?.push(result);
    process.stderr.write(
      `${result.ok ? "ok  " : "FAIL"} ${feature} · ${result.label} (${result.ms}ms)\n`,
    );
  };

  // Phase 1 — the CLI owns the database.
  for (const { name, clauses } of specs) {
    if (clauses.migration) add(name, await runMigrationClause(name, clauses.migration));
    if (clauses.service) add(name, await runServiceClause(name, clauses.service));
    if (clauses.entitlement) add(name, await runEntitlementClause(name, clauses.entitlement));
    for (const custom of clauses.custom ?? []) add(name, await runCustomClause(custom));
  }

  // Phase 2 — hand the database to one Next server.
  if (specs.some((s) => s.clauses.route)) {
    await closeAcceptDb();
    for (const { name, clauses } of specs) {
      if (clauses.route) add(name, await runRouteClause(clauses.route));
    }
  }

  // Phase 3 — Playwright brings its own server and its own database.
  if (specs.some((s) => s.clauses.e2e)) {
    stopServer();
    for (const { name, clauses } of specs) {
      if (clauses.e2e) add(name, await runE2eClause(clauses.e2e));
    }
  }

  const specResults: SpecResult[] = specs.map((spec) => {
    const clauses = results.get(spec.name) ?? [];
    if (clauses.length === 0) clauses.push(EMPTY_SPEC(spec.name));
    return {
      feature: spec.name,
      ok: clauses.every((c) => c.ok),
      ms: clauses.reduce((total, c) => total + c.ms, 0),
      clauses,
    };
  });

  return {
    ok: specResults.length > 0 && specResults.every((s) => s.ok),
    ms: Date.now() - started,
    ranAt: new Date().toISOString(),
    specs: specResults,
  };
}
