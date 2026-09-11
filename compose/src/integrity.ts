import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * Kit integrity — turning "built from Jetpack" from a claim into evidence.
 *
 * `listing.config.ts` declares `builtWith: { kit, version }` and a seller can
 * type anything there. This hashes a fenced set of files and compares them to
 * the manifest Z2H publishes for that kit version.
 *
 * **Fenced = every file the verify workflow executes from the seller's
 * checkout. Product code is never fenced.** That rule is the whole definition,
 * and it is why the list is what it is: the acceptance runner, the grader, the
 * schema lint, the setup entrypoint, the dead-utility check and the contrast
 * check are each invoked by path during a run, so each could decide an outcome. Everything else is the buyer's to rewrite
 * with no effect on the badge, because rewriting it is why they bought a kit.
 * A buyer can replace every page, table and component and still read `match`.
 *
 * `package.json#scripts` and `turbo.json` are deliberately **not** here. They
 * were, on the reasoning that the pipeline runs through `pnpm verify` — but the
 * verifying workflow now invokes every tool directly by path, so no
 * seller-defined script decides anything and there is nothing left to protect.
 * Hashing them anyway would have marked as `modified` every buyer who added a
 * `deploy` script, which is the normal thing to do, and the label would have
 * come to mean "used the kit" rather than "changed the referee".
 *
 * Hashes are sha256 over raw bytes with no newline normalisation, so a CRLF
 * checkout reads as `modified`. `.gitattributes` pins `eol=lf` to prevent it.
 */

export interface KitManifest {
  standard: "z2h-verified@1";
  kit: string;
  version: string;
  /** Posix path → sha256 over the file's raw bytes. Sorted, for determinism. */
  files: Record<string, string>;
}

type IntegrityState = "match" | "modified" | "absent";

export interface IntegrityResult {
  integrity: IntegrityState;
  /** Paths whose hash differs or that are missing. Sorted, so runs compare. */
  mismatches: string[];
}

/**
 * @param actual  path → sha256, measured from the repo being verified
 * @param manifest the published manifest for the declared kit version, or null
 *                 when the listing claims no kit
 */
export function compareToManifest(
  actual: Record<string, string>,
  manifest: KitManifest | null,
): IntegrityResult {
  if (!manifest) return { integrity: "absent", mismatches: [] };

  const fenced = Object.entries(manifest.files);
  const mismatches = fenced
    // A missing file is a modification, not a match by omission: deleting the
    // acceptance runner must never read the same as leaving it alone.
    .filter(([path, hash]) => actual[path] !== hash)
    .map(([path]) => path)
    .sort();

  // A file the manifest does not name is invisible here by construction — the
  // buyer's product is theirs to rewrite entirely without touching the badge.

  if (mismatches.length === 0) return { integrity: "match", mismatches: [] };

  // Every fenced file gone means the kit is not present at all, which is a
  // different claim from having altered it.
  const allMissing = fenced.every(([path]) => actual[path] === undefined);
  return { integrity: allMissing ? "absent" : "modified", mismatches };
}

/**
 * The set that defines "done".
 *
 * Product code is deliberately absent: changing it is why someone bought a kit,
 * and hashing it would report every genuine buyer as modified. `design/tokens.ts`
 * is absent for the same reason — adding a surface means adding a contrast pair,
 * which is the system working, not tampering.
 */
export const KIT_FILES: readonly string[] = [
  // The acceptance runner: it decides whether a feature met its own spec.
  "packages/acceptance/src",
  // The grader and the schema lint, which decide two of the six claims.
  "tooling/grade.ts",
  "tooling/lint-schema.ts",
  // One-command setup on a clean checkout is itself one of the claims, and the
  // workflow invokes this file by path rather than through `pnpm run setup`.
  "tooling/setup.ts",
  // Also executed by path in the verify step, so also referees.
  "tooling/check-dead-utilities.mts",
  "design/check.ts",
  // Not executed, but read by tools the verify step executes — and each one
  // decides what "passed" means. `vitest.config.ts` with an empty `include`
  // passes zero tests; `playwright.config.ts` pointed at an empty `testDir`
  // passes zero flows; `biome.json` with its rules off passes any code;
  // `tsconfig.base.json` with `strict: false` passes types it should not.
  // Config is a referee whenever a referee reads it.
  "apps/web/vitest.config.ts",
  "playwright.config.ts",
  "biome.json",
  "tsconfig.base.json",
];

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Every `.ts`/`.mts` under a directory, sorted, so two runs agree. */
function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, found);
    else if (/\.m?ts$/.test(entry) && !entry.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

/** Measure the kit files in a repository. Used to publish and to verify. */
export function measureKit(root: string): Record<string, string> {
  const measured: Record<string, string> = {};

  for (const entry of KIT_FILES) {
    const absolute = resolve(root, entry);
    // A fenced path that is absent is simply not measured; `compareToManifest`
    // is what decides whether that reads as `modified` or as `absent`.
    if (!existsSync(absolute)) continue;
    const paths = statSync(absolute).isDirectory() ? walk(absolute) : [absolute];
    for (const path of paths) {
      // Posix separators and raw bytes, so a Windows checkout and a Linux
      // runner produce the same manifest.
      const key = relative(root, path).split(sep).join("/");
      measured[key] = sha256(readFileSync(path));
    }
  }

  // Sorted, so `pnpm kit:manifest` is byte-identical run to run.
  return Object.fromEntries(Object.entries(measured).sort(([a], [b]) => (a < b ? -1 : 1)));
}
