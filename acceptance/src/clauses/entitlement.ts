/**
 * `entitlement` clause — the plan limit is really enforced, with the right HTTP
 * status. It resolves the limit key (`projects.max` → the `projects` slice),
 * imports that slice's `service.ts`, and drives its `create…` function against
 * the acceptance database until it refuses, then asserts the thrown `AppError`
 * carries `overLimitStatus`.
 *
 * It imports `service.ts` rather than `index.ts` on purpose: services are plain
 * functions taking `(db, ctx, input)`, so they run outside Next, while a slice's
 * index also re-exports server actions and client components that do not.
 *
 * `plan` resolves through the billing slice's plan catalogue
 * (`features/billing/plans.ts`). When the clause names a plan other than the
 * default, it seeds a subscription row for that plan first — that is what
 * "seeds a user on `plan`" means, and it is why a `pro` clause can assert an
 * unlimited ceiling.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { acceptDb, FEATURES_DIR } from "../env";
import type { ClauseResult, EntitlementClause, Failure } from "../types";

interface AppErrorShape {
  code?: string;
  httpStatus?: number;
  message?: string;
}

const PLANS_FILE = "apps/web/src/features/billing/plans.ts";

/** The slice a limit key belongs to: `projects.max` → `projects`. */
function sliceFor(limit: string): string {
  return limit.split(".")[0] ?? limit;
}

/**
 * Put the user on `plan` by writing the subscription row a webhook would have
 * written. The harness is allowed to set up state; it is not allowed to change
 * the behaviour under test, so it goes through the slice's own schema rather
 * than a test-only product function.
 */
async function seedPlan(db: unknown, userId: string, plan: string): Promise<void> {
  // The submodules, not the slice index: the index also re-exports client
  // components, which do not load outside Next.
  const { DEFAULT_PLAN } = (await import("@/features/billing/plans")) as {
    DEFAULT_PLAN: string;
  };
  const { subscriptions } = (await import("@/features/billing/schema")) as {
    subscriptions: unknown;
  };
  if (plan === DEFAULT_PLAN) return;

  const inserter = db as {
    insert: (table: unknown) => { values: (row: Record<string, unknown>) => Promise<unknown> };
  };
  await inserter.insert(subscriptions).values({
    id: randomUUID(),
    userId,
    organizationId: null,
    plan,
    status: "active",
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    stripeSubscriptionId: `sub_accept_${randomUUID()}`,
  });
}

type ServiceModule = Record<string, unknown>;
type DriverFn = (db: unknown, ctx: unknown, input: unknown) => Promise<unknown>;

/**
 * The function that spends the limit. When the clause names one, that is it —
 * a slice with several `create*` exports, or one whose spending function is not
 * a `create*` at all, has to say which. Otherwise fall back to the convention:
 * the slice's single `create*` export.
 */
function findDriverFn(
  mod: ServiceModule,
  named: string | undefined,
): { name: string; fn: DriverFn } | undefined {
  if (named) {
    return typeof mod[named] === "function"
      ? { name: named, fn: mod[named] as DriverFn }
      : undefined;
  }
  const names = Object.keys(mod).filter(
    (k) => k.startsWith("create") && typeof mod[k] === "function",
  );
  const name = names[0];
  if (!name) return undefined;
  return { name, fn: mod[name] as DriverFn };
}

/** What to pass on attempt `n` (1-based). A CRUD `create` takes a name. */
function inputFor(clause: EntitlementClause, attempt: number): unknown {
  return clause.input ? clause.input(attempt) : { name: `accept-${attempt}` };
}

export async function runEntitlementClause(
  feature: string,
  clause: EntitlementClause,
): Promise<ClauseResult> {
  const started = Date.now();
  const failures: Failure[] = [];
  const slice = sliceFor(clause.limit);
  const serviceFile = join(FEATURES_DIR, slice, "service.ts");

  const fail = (summary: string): ClauseResult => ({
    clause: "entitlement",
    label: `entitlement: ${clause.limit}`,
    ok: false,
    summary,
    ms: Date.now() - started,
    failures,
  });

  if (!existsSync(serviceFile)) {
    failures.push({
      file: `apps/web/src/features/${slice}/service.ts`,
      message: `expected a slice named "${slice}" (from the limit key "${clause.limit}") with a service.ts; it does not exist.`,
    });
    return fail(`no slice "${slice}" for limit "${clause.limit}"`);
  }

  const db = acceptDb();

  const plans = (await import("@/features/billing/plans")) as {
    isPlanId: (value: string) => boolean;
    limitFor: (plan: string, key: string) => number;
  };
  const mod = (await import(serviceFile)) as ServiceModule;
  const create = findDriverFn(mod, clause.fn);
  if (!create) {
    const wanted = clause.fn ? `an export named "${clause.fn}"` : 'a "create…" export';
    failures.push({
      file: `apps/web/src/features/${slice}/service.ts`,
      message: `expected ${wanted} to drive the limit with; service.ts exports [${Object.keys(mod).join(", ")}].`,
    });
    return fail(`no ${clause.fn ?? "create"} function in ${slice}/service.ts`);
  }

  const ctx = { userId: randomUUID(), organizationId: null };

  if (!plans.isPlanId(clause.plan)) {
    failures.push({
      file: PLANS_FILE,
      message: `expected "${clause.plan}" to be a plan in the catalogue; it is not. Add it to PLANS in ${PLANS_FILE}, or fix the accept spec's entitlement.plan.`,
    });
    return fail(`no plan named "${clause.plan}"`);
  }

  let max: number;
  try {
    max = plans.limitFor(clause.plan, clause.limit);
  } catch (err) {
    failures.push({
      file: PLANS_FILE,
      message: `expected limitFor("${clause.plan}", "${clause.limit}") to resolve; it threw: ${err instanceof Error ? err.message : String(err)}`,
    });
    return fail(`limit "${clause.limit}" is not defined`);
  }
  if (!Number.isFinite(max) || max < 1) {
    failures.push({
      file: PLANS_FILE,
      message: `expected "${clause.limit}" on plan "${clause.plan}" to be a finite limit of at least 1; got ${String(max)}. An unlimited plan has no ceiling to test — point the clause at the plan that does.`,
    });
    return fail(`limit "${clause.limit}" on "${clause.plan}" is ${String(max)}`);
  }

  // "Seeds a user on `plan`": the default plan needs no row; anything else does.
  await seedPlan(db, ctx.userId, clause.plan);

  let summary: string;
  for (let i = 0; i < max; i += 1) {
    try {
      await create.fn(db, ctx, inputFor(clause, i + 1));
    } catch (err) {
      failures.push({
        file: `apps/web/src/features/${slice}/service.ts`,
        message: `expected ${create.name} to succeed ${max} time(s) on plan "${clause.plan}" (the "${clause.limit}" limit); call ${i + 1} threw: ${err instanceof Error ? err.message : String(err)}`,
      });
      return fail(`${create.name} failed below the limit`);
    }
  }

  try {
    await create.fn(db, ctx, inputFor(clause, max + 1));
    failures.push({
      file: `apps/web/src/features/${slice}/service.ts`,
      message: `expected call ${max + 1} to ${create.name} to be refused with HTTP ${clause.overLimitStatus}; it succeeded. Enforce the limit with getLimit(ctx, "${clause.limit}") and throw EntitlementExceeded.`,
    });
    summary = `${create.name} ignored the "${clause.limit}" limit of ${max}`;
  } catch (err) {
    const e = err as AppErrorShape;
    if (e.httpStatus !== clause.overLimitStatus) {
      failures.push({
        file: `apps/web/src/features/${slice}/service.ts`,
        message: `expected call ${max + 1} to ${create.name} to throw an AppError with httpStatus ${clause.overLimitStatus}; got ${e.httpStatus ?? "no httpStatus"} (${e.code ?? "no code"}): ${e.message ?? String(err)}. Throw EntitlementExceeded from server/errors.ts.`,
      });
      summary = `over-limit call returned ${e.httpStatus ?? "an untyped error"}, expected ${clause.overLimitStatus}`;
    } else {
      summary = `${create.name} enforces "${clause.limit}" (${max}) and returns ${clause.overLimitStatus} past it`;
    }
  }

  return {
    clause: "entitlement",
    label: `entitlement: ${clause.limit}`,
    ok: failures.length === 0,
    summary,
    ms: Date.now() - started,
    failures,
  };
}
