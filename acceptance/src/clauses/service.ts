/**
 * `service` clause — two assertions:
 *  1. the named function is exported from the slice's `index.ts` (its ONLY
 *     public surface), checked by parsing the file with the TypeScript compiler
 *     rather than importing it, so a slice with client components or "use
 *     server" actions can still be checked outside Next;
 *  2. the named Vitest file passes and at least one passing test references the
 *     function — a green file that never calls it does not count.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { acceptEnv, bin, FEATURES_DIR, WEB_DIR } from "../env";
import type { ClauseResult, Failure, ServiceClause } from "../types";

/** Every identifier `file` exports, following `export * from "./x"` one level. */
function exportedNames(file: string, seen = new Set<string>()): Set<string> {
  const names = new Set<string>();
  if (seen.has(file) || !existsSync(file)) return names;
  seen.add(file);

  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) names.add(element.name.text);
        continue;
      }
      // `export * from "./service"` — follow it.
      const spec = statement.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec) && spec.text.startsWith(".")) {
        const target = resolveRelative(file, spec.text);
        if (target) for (const n of exportedNames(target, seen)) names.add(n);
      }
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;

    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (statement.name) names.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
      }
    }
  }
  return names;
}

function resolveRelative(from: string, specifier: string): string | undefined {
  const base = join(from, "..", specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

interface VitestJson {
  numFailedTests?: number;
  testResults?: Array<{
    name?: string;
    assertionResults?: Array<{ status?: string; title?: string; fullName?: string }>;
  }>;
}

export async function runServiceClause(
  feature: string,
  clause: ServiceClause,
): Promise<ClauseResult> {
  const started = Date.now();
  const failures: Failure[] = [];
  const indexFile = join(FEATURES_DIR, feature, "index.ts");

  const exported = exportedNames(indexFile);
  if (!exported.has(clause.fn)) {
    failures.push({
      file: `apps/web/src/features/${feature}/index.ts`,
      message: `expected "${clause.fn}" to be exported from the slice's index.ts; it exports [${[...exported].sort().join(", ") || "nothing"}]. A slice's index.ts is its only public surface — add the export there.`,
    });
  }

  const testFile = join(WEB_DIR, clause.test);
  if (!existsSync(testFile)) {
    failures.push({
      file: `apps/web/${clause.test}`,
      message: `expected the test file to exist; it does not. The accept spec's service.test path is relative to apps/web.`,
    });
    return done(started, clause, failures, `test file apps/web/${clause.test} is missing`);
  }

  let parsed: VitestJson = {};
  let raw = "";
  try {
    raw = execFileSync(bin("vitest"), ["run", clause.test, "--reporter=json", "--silent"], {
      cwd: WEB_DIR,
      env: acceptEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
      timeout: 10 * 60_000,
    });
  } catch (err) {
    raw = (err as { stdout?: string }).stdout ?? "";
  }
  try {
    parsed = JSON.parse(raw.slice(raw.indexOf("{"))) as VitestJson;
  } catch {
    failures.push({
      file: `apps/web/${clause.test}`,
      message: `could not parse Vitest's JSON report. Run \`pnpm --filter @jetpack/web exec vitest run ${clause.test}\` to see the real output.`,
    });
    return done(started, clause, failures, "vitest produced no parseable report");
  }

  const assertions = (parsed.testResults ?? []).flatMap((r) => r.assertionResults ?? []);
  const failed = assertions.filter((a) => a.status === "failed");
  for (const a of failed) {
    failures.push({
      file: `apps/web/${clause.test}`,
      message: `expected every test in the file to pass; "${a.fullName ?? a.title}" failed.`,
    });
  }

  const passing = assertions.filter((a) => a.status === "passed");
  const source = readFileSync(testFile, "utf8");
  if (!new RegExp(`\\b${escapeRegExp(clause.fn)}\\b`).test(source)) {
    failures.push({
      file: `apps/web/${clause.test}`,
      message: `expected at least one test to exercise "${clause.fn}"; the file never mentions it. A green test file that does not call the service does not make the feature done.`,
    });
  } else if (passing.length === 0) {
    failures.push({
      file: `apps/web/${clause.test}`,
      message: `expected ≥1 passing test exercising "${clause.fn}"; the file has ${assertions.length} test(s), none passing.`,
    });
  }

  const summary =
    failures.length === 0
      ? `"${clause.fn}" is exported and covered by ${passing.length} passing test(s)`
      : `"${clause.fn}" failed ${failures.length} expectation(s)`;
  return done(started, clause, failures, summary);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function done(
  started: number,
  clause: ServiceClause,
  failures: Failure[],
  summary: string,
): ClauseResult {
  return {
    clause: "service",
    label: `service: ${clause.fn}`,
    ok: failures.length === 0,
    summary,
    ms: Date.now() - started,
    failures,
  };
}
