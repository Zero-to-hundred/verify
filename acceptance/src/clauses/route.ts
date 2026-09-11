/**
 * `route` clause — the page actually serves. Boots the app against the
 * acceptance database, signs in through the real magic-link flow when the route
 * is authed, requests the path, and asserts the status. This is the clause that
 * catches "the service is perfect but nobody wired a page".
 */
import { ACCEPT_BASE_URL } from "../env";
import { ensureServer, signInFreshUser } from "../server";
import type { ClauseResult, Failure, RouteClause } from "../types";

export async function runRouteClause(clause: RouteClause): Promise<ClauseResult> {
  const started = Date.now();
  const failures: Failure[] = [];
  let summary: string;

  try {
    await ensureServer();

    const headers: Record<string, string> = clause.authed
      ? { cookie: await signInFreshUser() }
      : {};
    const res = await fetch(`${ACCEPT_BASE_URL}${clause.path}`, { headers, redirect: "manual" });

    if (res.status !== clause.status) {
      const hint = hintFor(clause, res.status);
      failures.push({
        file: "apps/web/src/app",
        message: `expected GET ${clause.path} (${clause.authed ? "signed in" : "signed out"}) to return ${clause.status}; got ${res.status}.${hint}`,
      });
      summary = `GET ${clause.path} returned ${res.status}, expected ${clause.status}`;
    } else {
      summary = `GET ${clause.path} returned ${clause.status} as expected`;
    }
  } catch (err) {
    failures.push({ message: err instanceof Error ? err.message : String(err) });
    summary = `could not exercise ${clause.path}`;
  }

  return {
    clause: "route",
    label: `route: ${clause.path}`,
    ok: failures.length === 0,
    summary,
    ms: Date.now() - started,
    failures,
  };
}

function hintFor(clause: RouteClause, status: number): string {
  if (status === 404) {
    return ` No page is mounted at ${clause.path} — add apps/web/src/app/(app)${clause.path}/page.tsx, or drop the route clause from accept.ts.`;
  }
  if (clause.authed && (status === 307 || status === 302)) {
    return " The request was redirected: the session cookie did not reach the page, or the route is not under the authed shell.";
  }
  if (status >= 500) {
    return " The page threw. Run `pnpm dev` and open the path to see the stack.";
  }
  return "";
}
