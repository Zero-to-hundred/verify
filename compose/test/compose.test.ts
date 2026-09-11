import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ComposeError, compose, fetchManifest } from "../src/compose";
import type { KitManifest } from "../src/integrity";

/**
 * The compose tool is the only thing in a verification run that decides what the
 * attestation says, so it is the one place a mistake becomes a signed lie.
 *
 * These fixtures are the kit's own: the real manifest, and hashes measured from
 * the real checkout. Synthetic ones would pass while the thing they stand in for
 * drifted.
 */
const KIT_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const manifest = JSON.parse(
  readFileSync(join(KIT_ROOT, "z2h", "kit-manifest.json"), "utf8"),
) as KitManifest;

const green = {
  exits: { setup: 0, verify: 0, acceptance: 0, e2e: 0 },
  measured: manifest.files,
  manifest,
  kit: "jetpack",
  kitVersion: "0.1.0",
  grade: { provider: "qlty", grade: "A" },
  coverage: 96.83,
  commit: "fbd4fc84453067ac92a0cd169f0300b070afb906",
  runUrl: "https://github.com/acme/app/actions/runs/1",
  hasAgentsMd: true,
  hasOneCommandSetup: true,
  license: "LICENSE.md",
  now: new Date("2026-09-10T12:00:00.000Z"),
};

test("a clean clone with every step green is a match", () => {
  const attestation = compose(green);
  expect(attestation.kit.integrity).toBe("match");
  expect(attestation.checks.acceptance.passed).toBe(true);
  expect(attestation.runner).toBe("github");
});

test("a weakened acceptance clause is modified, and names the file", () => {
  const clause = "packages/acceptance/src/clauses/entitlement.ts";
  const attestation = compose({
    ...green,
    measured: { ...manifest.files, [clause]: "tampered" },
  });
  expect(attestation.kit.integrity).toBe("modified");
  expect(attestation.kit.mismatches).toEqual([clause]);
});

test("every fenced file missing is absent", () => {
  expect(compose({ ...green, measured: {} }).kit.integrity).toBe("absent");
});

/**
 * A red step is a result, not an abort. The attestation must be able to say
 * "acceptance failed" — a verification that only ever records success is a
 * marketing asset, not a check.
 */
test("a failed acceptance step still produces an attestation, recording the failure", () => {
  const attestation = compose({ ...green, exits: { ...green.exits, acceptance: 1 } });
  expect(attestation.checks.acceptance).toEqual({ passed: false, exitCode: 1 });
  expect(attestation.checks.verify.passed).toBe(true);
});

test("a grade the grader could not produce fails the run", () => {
  expect(() => compose({ ...green, grade: { provider: "qlty", grade: "?" } })).toThrow(
    ComposeError,
  );
});

test("coverage outside 0-100 fails the run", () => {
  expect(() => compose({ ...green, coverage: 140 })).toThrow(ComposeError);
});

test("coverage may legitimately be unmeasured", () => {
  expect(compose({ ...green, coverage: null }).coverage).toBeNull();
});

/**
 * A 404 means the marketplace has no manifest for this version. That is a claim
 * about us, not about the seller, and must never be recorded as `absent` — which
 * says their files are missing.
 */
test("a missing manifest fails the run rather than reporting absent", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("not found", { status: 404 })) as unknown as typeof fetch;
  try {
    await expect(
      fetchManifest("https://z2h.test/kits/jetpack/9.9.9/manifest.json"),
    ).rejects.toThrow(/does not publish a manifest/);
  } finally {
    globalThis.fetch = original;
  }
});

test("a manifest that is not json is refused", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("<html>hello</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as unknown as typeof fetch;
  try {
    await expect(
      fetchManifest("https://z2h.test/kits/jetpack/0.1.0/manifest.json"),
    ).rejects.toThrow(/not application\/json/);
  } finally {
    globalThis.fetch = original;
  }
});

/**
 * `schema.ts` and `integrity.ts` are copies of the kit's own, so that the
 * marketplace, the kit and this tool cannot disagree about what an attestation
 * is. A copy that drifts is worse than no copy: both sides would be confident.
 */
test.each(["schema.ts", "integrity.ts"])(
  "%s is still a byte-identical copy of the kit's",
  (file) => {
    const copy = readFileSync(join(import.meta.dirname, "..", "src", file), "utf8");
    const original = readFileSync(join(KIT_ROOT, "z2h", file), "utf8");
    expect(
      copy,
      `z2h/verify-workflow/compose/src/${file} has drifted from z2h/${file}. Copy it again; do not edit one side.`,
    ).toBe(original);
  },
);

/**
 * The referee's transpilation config is vendored, never inherited.
 *
 * `paths` is a module-resolution table. A config that `extends` something from
 * the repository being verified lets a seller map `@/features/*` at stubs and
 * redirect what the runner loads — without touching a single fenced file, and
 * without the integrity check having anything to say about it.
 */
test("the vendored runner config inherits nothing from the seller", () => {
  const tsconfig = JSON.parse(
    readFileSync(
      join(KIT_ROOT, "z2h", "verify-workflow", "public-repo", "acceptance", "tsconfig.run.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;

  expect(
    tsconfig.extends,
    "the vendored tsconfig has an `extends`. Inside a seller's checkout that " +
      "resolves to their file, and `paths` there decides what the referee loads.",
  ).toBeUndefined();

  // The one thread that must remain: their specs import their product this way.
  expect((tsconfig.compilerOptions as { paths: Record<string, string[]> }).paths).toEqual({
    "@/*": ["../../apps/web/src/*"],
  });
});
