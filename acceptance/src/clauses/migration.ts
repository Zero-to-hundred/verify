/**
 * `migration` clause — the table and every listed column exist in the LIVE
 * database, created by the real migration files. This is what proves a slice was
 * actually migrated rather than merely typed.
 */
import { sql } from "drizzle-orm";
import { acceptDb } from "../env";
import type { ClauseResult, Failure, MigrationClause } from "../types";

interface ColumnRow {
  column_name: string;
}

export async function runMigrationClause(
  feature: string,
  clause: MigrationClause,
): Promise<ClauseResult> {
  const started = Date.now();
  const db = acceptDb();
  const failures: Failure[] = [];
  let summary: string;

  {
    const result = await db.execute(
      sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${clause.table}`,
    );
    const found = (result.rows as unknown as ColumnRow[]).map((r) => r.column_name);

    if (found.length === 0) {
      failures.push({
        file: `packages/db/migrations`,
        message: `expected table "${clause.table}" to exist in the acceptance database; it does not. Run \`pnpm db:generate && pnpm db:migrate\` after editing schema.ts.`,
      });
      summary = `table "${clause.table}" is missing — the slice was never migrated`;
    } else {
      const missing = clause.columns.filter((c) => !found.includes(c));
      for (const column of missing) {
        failures.push({
          file: `apps/web/src/features/${feature}/schema.ts`,
          message: `expected column "${clause.table}"."${column}"; the table has [${found.join(", ")}]. DB columns are snake_case (userId: text("user_id")).`,
        });
      }
      summary =
        missing.length === 0
          ? `table "${clause.table}" has all ${clause.columns.length} expected columns`
          : `table "${clause.table}" is missing ${missing.length} column(s): ${missing.join(", ")}`;
    }
  }

  return {
    clause: "migration",
    label: `migration: ${clause.table}`,
    ok: failures.length === 0,
    summary,
    ms: Date.now() - started,
    failures,
  };
}
