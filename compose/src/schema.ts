/**
 * The Zero to Hundred listing manifest, as Zod.
 *
 * Every constraint here is transcribed from `guide/z2h-mcp-schema.md`, which was
 * captured from the live `z2h` MCP server — not from the plan's guess at what
 * the API would look like. Where the two disagreed, the server won. Read that
 * document before changing anything in this file; the two move together.
 *
 * `pnpm listing:validate` runs this, so a manifest that would be rejected by the
 * marketplace fails locally in a second instead of after a round trip.
 */
import { z } from "zod";

/** The server's `type` enum, verbatim. */
export const ListingType = z.enum([
  "full_product",
  "micro_saas",
  "tool",
  "template",
  "ai_agent",
  "component",
  "bot",
  "extension",
  "automation",
]);

/** The server's `operatingStatus` enum, verbatim. */
export const OperatingStatus = z.enum(["ready_to_launch", "live", "live_with_revenue"]);

export const ListingConfig = z.object({
  // ── fields the server actually accepts ──────────────────────────────────────
  title: z.string().min(3).max(200),
  /** The server caps this at 160. Longer is rejected, not truncated. */
  shortDescription: z.string().min(10).max(160),
  /** Markdown. The server's floor is 20 characters; ours is higher on purpose. */
  longDescription: z.string().min(200),
  type: ListingType,
  operatingStatus: OperatingStatus,
  /**
   * Whole **US dollars** — confirmed by the marketplace owner on 2026-08-29.
   * The server's schema still says only `number`, so the field keeps its unit
   * in its name: sending cents to a field that wants dollars overprices a
   * listing by 100× and nothing on either side would catch it.
   */
  askingPriceUsd: z.number().int().nonnegative().optional(),
  demoUrl: z.url().optional(),
  /** The server asks for `github.com/<owner>/<repo>`. */
  sourceRepoUrl: z.url().optional(),
  techStack: z.array(z.string().min(1)).min(1).max(20),
  domains: z.array(z.string().min(1)).optional(),

  // ── fields the marketplace has no home for ──────────────────────────────────
  /** Rendered into `longDescription`; there is no licence field. */
  license: z.string().min(1),
  /** Path to the generated handoff doc (P6b.7). */
  handoffDoc: z.string().min(1),
  /** Self-declared and cosmetic; the attestation is the part that is earned. */
  builtWith: z.object({ kit: z.string().min(1), version: z.string().min(1) }),
  /** Who publishes it. The thumbnail's eyebrow — the headline is the product. */
  publisher: z.string().min(1),
  /**
   * The thumbnail. Rendered locally and uploaded **by hand** on the listing's
   * editUrl — the server exposes no image field. See `guide/z2h-mcp-schema.md` §1.
   */
  thumbnail: z.object({
    /** oklch, so it can be contrast-checked like everything else. */
    accent: z.string().startsWith("oklch("),
    badge: z.string().optional(),
  }),
});

export type ListingConfig = z.infer<typeof ListingConfig>;

/**
 * The payload actually sent to `z2h_create_draft_listing`. Deriving it here — in
 * one place — is what stops a field the server does not accept from being sent,
 * and what makes the dry-run honest about what will really go.
 */
export function toCreatePayload(config: ListingConfig): Record<string, unknown> {
  return {
    title: config.title,
    shortDescription: config.shortDescription,
    longDescription: config.longDescription,
    type: config.type,
    operatingStatus: config.operatingStatus,
    ...(config.askingPriceUsd === undefined ? {} : { askingPrice: config.askingPriceUsd }),
    ...(config.demoUrl ? { demoUrl: config.demoUrl } : {}),
    ...(config.sourceRepoUrl ? { sourceRepoUrl: config.sourceRepoUrl } : {}),
    techStack: config.techStack,
    ...(config.domains ? { domains: config.domains } : {}),
  };
}

/**
 * The update payload. Deliberately narrower than create: the server rejects
 * `type`, `operatingStatus` and `domains` on update, and requires `slug`.
 */
export function toUpdatePayload(config: ListingConfig, slug: string): Record<string, unknown> {
  return {
    slug,
    title: config.title,
    shortDescription: config.shortDescription,
    longDescription: config.longDescription,
    ...(config.askingPriceUsd === undefined ? {} : { askingPrice: config.askingPriceUsd }),
    ...(config.demoUrl ? { demoUrl: config.demoUrl } : {}),
    ...(config.sourceRepoUrl ? { sourceRepoUrl: config.sourceRepoUrl } : {}),
    techStack: config.techStack,
  };
}

// ── attestation (P6b.6) ───────────────────────────────────────────────────────

/**
 * The "Z2H Verified" attestation. The marketplace has no endpoint to receive it
 * yet, so this is produced, uploaded as a CI artifact,
 * and summarised in the listing description.
 *
 * **Only a run in GitHub Actions is trustworthy.** `runner: "local"` exists so a
 * seller can preview the shape; a self-reported pass is worth nothing, because
 * the entire value of the badge is that somebody other than the seller checked.
 */
/** One pipeline step, and whether it passed. */
const Check = z
  .object({
    passed: z.boolean(),
    /** The step's exit code, as the workflow observed it. */
    exitCode: z.number().int(),
  })
  .strict();

/**
 * The attestation, as the verifying workflow writes it.
 *
 * `.strict()` throughout, deliberately: the marketplace derives `badgeState`
 * itself and a client must never be able to send one. An unknown key is a
 * rejected submission, not a field to ignore.
 *
 * Repo identity is **not** in here. It comes from the Sigstore certificate the
 * provenance attestation carries — Source Repository URI and Source Repository
 * Owner Identifier, stamped by GitHub's OIDC issuer — which is what proves the
 * submitting seller controls the repo. A JSON field could say anything.
 */
export const attestationSchema = z
  .object({
    standard: z.literal("z2h-verified@1"),
    commit: z.string().min(7),
    ranAt: z.iso.datetime(),
    runner: z.enum(["github", "local"]),
    /** The workflow run, so a buyer can read what actually ran. Null locally. */
    runUrl: z.string().url().nullable(),

    /**
     * Which kit this was built from, and whether the code that decides whether
     * it passed is the code that kit published. See `integrity.ts` for why the
     * fence covers the referee and not the product.
     */
    kit: z
      .object({
        name: z.string().min(1),
        version: z.string().min(1),
        integrity: z.enum(["match", "modified", "absent"]),
        /** Fenced paths that differ. Empty unless `integrity` is `modified`. */
        mismatches: z.array(z.string()),
      })
      .strict(),

    checks: z
      .object({
        setup: Check,
        verify: Check,
        acceptance: Check,
        e2e: Check,
      })
      .strict(),

    grade: z.object({ provider: z.string().min(1), grade: z.string().min(1) }).strict(),
    /** **Line** coverage, not a quality score. See `guide/VERIFICATION.md`. */
    coverage: z.number().min(0).max(100).nullable(),
    hasAgentsMd: z.boolean(),
    hasOneCommandSetup: z.boolean(),
    license: z.string().nullable(),
  })
  .strict();

export type Attestation = z.infer<typeof attestationSchema>;

/** Every check passed, and it was produced somewhere that can be trusted. */
export function isVerified(attestation: Attestation): boolean {
  const c = attestation.checks;
  return (
    attestation.runner === "github" &&
    c.setup.passed &&
    c.verify.passed &&
    c.acceptance.passed &&
    c.e2e.passed &&
    attestation.hasAgentsMd &&
    attestation.hasOneCommandSetup &&
    attestation.license !== null
  );
}
