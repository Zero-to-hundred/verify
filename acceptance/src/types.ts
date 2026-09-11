/**
 * The acceptance DSL types (spec §7b.1). A feature is done when `pnpm accept
 * <feature>` passes every clause. The generator stamps a starter `accept.ts`
 * with the migration/service/route clauses pre-filled.
 */

/** Assert the table and DB columns exist in the live database (both drivers). */
export interface MigrationClause {
  table: string;
  /** DB column names (snake_case). */
  columns: string[];
}

/** Assert the named export exists on the slice's index.ts and a test exercises it. */
export interface ServiceClause {
  fn: string;
  /** Path to the Vitest file, relative to apps/web. */
  test: string;
}

/** Boot the app, optionally sign in, request the path, assert the status. */
export interface RouteClause {
  path: string;
  authed: boolean;
  status: number;
}

/** Drive a service to its plan limit and assert the next call yields the status. */
export interface EntitlementClause {
  plan: string;
  /** A key `server/entitlements.ts` (later `billing/plans.ts`) knows, e.g. `projects.max`. */
  limit: string;
  overLimitStatus: number;
  /**
   * The `service.ts` export that consumes the limit. Defaults to the slice's
   * single `create*` export, which is right for a CRUD slice. Name it when the
   * slice has more than one `create*`, or when the function that spends the
   * limit is not the one that creates the row.
   */
  fn?: string;
  /**
   * The input for attempt `n` (1-based). Defaults to `{ name: "accept-<n>" }`,
   * which is what a CRUD `create` takes. Override it when the driving function
   * needs something else — a chat turn needs a message, not a name.
   */
  input?: (attempt: number) => unknown;
}

/** Escape hatch: a named assertion the runner awaits. */
export interface CustomClause {
  name: string;
  run: () => Promise<void>;
}

export interface AcceptanceClauses {
  migration?: MigrationClause;
  service?: ServiceClause;
  route?: RouteClause;
  entitlement?: EntitlementClause;
  /** Path to a Playwright spec, relative to the repo root. */
  e2e?: string;
  custom?: CustomClause[];
}

export interface AcceptanceSpec {
  name: string;
  clauses: AcceptanceClauses;
}

// ── results ───────────────────────────────────────────────────────────────────

export type ClauseName = "migration" | "service" | "route" | "entitlement" | "e2e" | "custom";

/**
 * One failed expectation. `message` always says what was expected AND what was
 * observed — an agent debugs from this text alone (Rule B8/B10).
 */
export interface Failure {
  /** Repo-relative path, when the failure can be located in a file. */
  file?: string;
  line?: number;
  message: string;
}

export interface ClauseResult {
  clause: ClauseName;
  /** Human label, e.g. `custom: seeds a demo row`. */
  label: string;
  ok: boolean;
  /** One sentence a human or agent can act on. */
  summary: string;
  ms: number;
  failures: Failure[];
  /** True when the clause is absent from the spec and was not run. */
  skipped?: boolean;
}

export interface SpecResult {
  feature: string;
  ok: boolean;
  ms: number;
  clauses: ClauseResult[];
}

export interface AcceptRunResult {
  ok: boolean;
  ms: number;
  ranAt: string;
  specs: SpecResult[];
}
