/**
 * Compose a `z2h-verified@1` attestation from the outcomes of a verification run.
 *
 * Pure on purpose. Every input arrives as an argument — step exit codes from the
 * workflow, the canonical manifest from Z2H's origin, the measured hashes from
 * the checkout — so there is no path by which this reads something the seller
 * wrote. `cli.ts` does the IO and hands the results here.
 *
 * The rule this exists to hold: an attestation records what happened, including
 * failure. A red step produces `passed: false`, not an aborted run and not a
 * missing file. Only the inability to produce evidence at all is fatal.
 */
import { compareToManifest, type KitManifest } from "./integrity";
import { type Attestation, attestationSchema } from "./schema";

export interface ComposeInput {
  exits: { setup: number; verify: number; acceptance: number; e2e: number };
  /** Hashes measured from the checkout by `measureKit`. */
  measured: Record<string, string>;
  /** The canonical manifest, fetched from Z2H. Never read from the checkout. */
  manifest: KitManifest;
  kit: string;
  kitVersion: string;
  grade: { provider: string; grade: string };
  /** Line coverage, or null when the run did not measure it. */
  coverage: number | null;
  commit: string;
  runUrl: string;
  hasAgentsMd: boolean;
  hasOneCommandSetup: boolean;
  license: string | null;
  now: Date;
}

const GRADES = new Set(["A", "B", "C", "D", "E", "F"]);

/** Thrown for input a run cannot proceed without. Never produces a partial file. */
export class ComposeError extends Error {}

export function compose(input: ComposeInput): Attestation {
  if (!GRADES.has(input.grade.grade)) {
    throw new ComposeError(
      `grade "${input.grade.grade}" is not one of A–F. The grader did not produce a usable result, so there is nothing to attest.`,
    );
  }
  if (input.coverage !== null && (input.coverage < 0 || input.coverage > 100)) {
    throw new ComposeError(`coverage ${input.coverage} is outside 0–100.`);
  }

  const { integrity, mismatches } = compareToManifest(input.measured, input.manifest);

  const check = (exitCode: number) => ({ passed: exitCode === 0, exitCode });

  // Parsed rather than cast: composing something the marketplace would reject is
  // a bug worth finding here, in the run that produced it.
  return attestationSchema.parse({
    standard: "z2h-verified@1",
    commit: input.commit,
    ranAt: input.now.toISOString(),
    // Hard-coded: this file only ever runs inside the Z2H workflow. A local run
    // uses the kit's own `pnpm attest`, which stamps `local` and earns nothing.
    runner: "github",
    runUrl: input.runUrl,
    kit: {
      name: input.kit,
      version: input.kitVersion,
      integrity,
      mismatches,
    },
    checks: {
      setup: check(input.exits.setup),
      verify: check(input.exits.verify),
      acceptance: check(input.exits.acceptance),
      e2e: check(input.exits.e2e),
    },
    grade: input.grade,
    coverage: input.coverage,
    hasAgentsMd: input.hasAgentsMd,
    hasOneCommandSetup: input.hasOneCommandSetup,
    license: input.license,
  });
}

/**
 * Fetch the canonical manifest.
 *
 * Deliberately strict: a redirect could point anywhere, a non-JSON body means
 * something other than a manifest answered, and a 404 means the marketplace
 * does not know this kit version. **A 404 is not `absent`** — `absent` says the
 * files are missing from the checkout, which is a claim about the seller. Not
 * knowing the version is a claim about us, and it fails the run instead.
 */
export async function fetchManifest(url: string, timeoutMs = 10_000): Promise<KitManifest> {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  }).catch((cause: unknown) => {
    throw new ComposeError(`could not fetch the kit manifest from ${url}: ${String(cause)}`);
  });

  if (response.status === 404) {
    throw new ComposeError(
      `the marketplace does not publish a manifest for this kit version (404 at ${url}). It cannot be verified against a kit nobody has recorded.`,
    );
  }
  if (!response.ok) {
    throw new ComposeError(`fetching the kit manifest returned ${response.status} at ${url}.`);
  }
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) {
    throw new ComposeError(
      `the kit manifest at ${url} is not application/json. Something other than a manifest answered.`,
    );
  }

  return (await response.json()) as KitManifest;
}
