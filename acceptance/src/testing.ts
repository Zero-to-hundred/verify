/**
 * What an `accept.ts` `custom` clause is allowed to reach for.
 *
 * A custom clause runs inside the acceptance CLI, which already owns the one
 * handle to `.pglite/accept` — embedded PGlite is single-writer, so a clause
 * that opened its own client would abort the run. So it borrows this one.
 */
export { acceptDb } from "./env";
