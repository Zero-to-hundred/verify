#!/usr/bin/env node
/**
 * `verify-compose compose --…` — the only thing in the verification run that
 * decides what the attestation says.
 *
 * It reads: the flags the workflow passes, the manifest at the Z2H origin, and
 * the bytes of the fenced kit files in the checkout. It does not read
 * `z2h/kit-manifest.json` from the checkout, a committed `attestation.json`, or
 * `package.json#scripts`. Those are all things a seller can write.
 *
 * Any missing or malformed input exits non-zero without writing, because half an
 * attestation is worse than none: it would be signed just the same.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ComposeError, compose, fetchManifest } from "./compose";
import { measureKit } from "./integrity";

const FLAGS = [
  "setup-exit",
  "verify-exit",
  "acceptance-exit",
  "e2e-exit",
  "manifest-url",
  "kit",
  "kit-version",
  "grade-file",
  "commit",
  "run-url",
  "out",
] as const;

const USAGE = `verify-compose compose [flags]

Composes a z2h-verified@1 attestation. Every value comes from a flag, the kit
manifest at --manifest-url, or the bytes of the checkout. Nothing is read from
files the seller could have written.

  --setup-exit <int>       exit code of the setup step
  --verify-exit <int>      exit code of the verify step
  --acceptance-exit <int>  exit code of the acceptance step
  --e2e-exit <int>         exit code of the end-to-end step
  --manifest-url <url>     canonical kit manifest, served by Z2H
  --kit <name>             kit the listing declares, e.g. jetpack
  --kit-version <version>  version the listing declares
  --grade-file <path>      grader output, read for the letter and line coverage
  --commit <sha>           the commit being attested
  --run-url <url>          the workflow run, so a buyer can read what ran
  --out <path>             where to write the attestation
  --root <path>            repository root to measure (default: cwd)
`;

function parse(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag?.startsWith("--")) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ComposeError(`${flag} needs a value.`);
    }
    args[flag.slice(2)] = value;
    i += 1;
  }
  return args;
}

function intFlag(args: Record<string, string>, name: string): number {
  const raw = args[name];
  if (raw === undefined) throw new ComposeError(`--${name} is required.`);
  const value = Number(raw);
  if (!Number.isInteger(value))
    throw new ComposeError(`--${name} must be an integer, got "${raw}".`);
  return value;
}

function stringFlag(args: Record<string, string>, name: string): string {
  const value = args[name];
  if (value === undefined || value === "") throw new ComposeError(`--${name} is required.`);
  return value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h") || argv[0] !== "compose") {
    console.log(USAGE);
    process.exit(argv.includes("--help") || argv.includes("-h") ? 0 : 1);
  }

  const args = parse(argv.slice(1));
  for (const unknown of Object.keys(args)) {
    if (!FLAGS.includes(unknown as (typeof FLAGS)[number]) && unknown !== "root") {
      throw new ComposeError(`unknown flag --${unknown}.`);
    }
  }

  const root = args.root ?? process.cwd();
  const gradeFile = join(root, stringFlag(args, "grade-file"));
  if (!existsSync(gradeFile)) {
    throw new ComposeError(
      `--grade-file ${gradeFile} does not exist. The grader produced nothing, so there is no grade to attest.`,
    );
  }
  const graded = JSON.parse(readFileSync(gradeFile, "utf8")) as {
    qlty?: { grade?: string };
    coverage?: { lines?: number | null };
  };
  if (!graded.qlty?.grade) {
    throw new ComposeError(`${gradeFile} carries no grade.`);
  }

  const attestation = compose({
    exits: {
      setup: intFlag(args, "setup-exit"),
      verify: intFlag(args, "verify-exit"),
      acceptance: intFlag(args, "acceptance-exit"),
      e2e: intFlag(args, "e2e-exit"),
    },
    measured: measureKit(root),
    manifest: await fetchManifest(stringFlag(args, "manifest-url")),
    kit: stringFlag(args, "kit"),
    kitVersion: stringFlag(args, "kit-version"),
    grade: { provider: "qlty", grade: graded.qlty.grade },
    coverage: graded.coverage?.lines ?? null,
    commit: stringFlag(args, "commit"),
    runUrl: stringFlag(args, "run-url"),
    hasAgentsMd: existsSync(join(root, "AGENTS.md")),
    hasOneCommandSetup: existsSync(join(root, "tooling", "setup.ts")),
    license:
      ["LICENSE", "LICENSE.md", "LICENCE", "LICENCE.md", "LICENSE.txt"].find((name) =>
        existsSync(join(root, name)),
      ) ?? null,
    now: new Date(),
  });

  writeFileSync(join(root, stringFlag(args, "out")), `${JSON.stringify(attestation, null, 2)}\n`);
  console.log(
    `✓ ${attestation.kit.name}@${attestation.kit.version} · integrity ${attestation.kit.integrity} · grade ${attestation.grade.grade}`,
  );
}

main().catch((error: unknown) => {
  console.error(
    `✗ verify-compose: ${error instanceof Error ? error.message : String(error)}\n\nNothing was written.`,
  );
  process.exit(1);
});
