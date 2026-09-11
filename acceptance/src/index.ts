import type { AcceptanceClauses, AcceptanceSpec } from "./types";

/**
 * Declare a slice's acceptance spec. The default export of every
 * `features/<name>/accept.ts`, executed by `pnpm accept <name>`.
 */
export function acceptance(name: string, clauses: AcceptanceClauses): AcceptanceSpec {
  return { name, clauses };
}

export type {
  AcceptanceClauses,
  AcceptanceSpec,
  AcceptRunResult,
  ClauseName,
  ClauseResult,
  CustomClause,
  EntitlementClause,
  Failure,
  MigrationClause,
  RouteClause,
  ServiceClause,
  SpecResult,
} from "./types";
