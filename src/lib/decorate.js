import { getReportMeta, getProtected, getLatestFor } from './store.js';
import { fetchUsersBulk } from './jira.js';
import { planReclaim, reasonText } from './reclaim.js';

/** Who is protected from reclaim, and why. */
export const protectedReasonFor = (accountId, protectedList, me) =>
  accountId === me ? 'self' : protectedList[accountId] ? 'protected' : null;

/**
 * Pure: the last action that still says something about a row. A scan lists
 * only people who hold a seat while it runs, so an action from before the
 * scan started (a reclaim since reversed outside the app, an old failure) is
 * out of date and is ignored. Reports built before the start time was kept
 * have no `startedAt`; for those every action counts, as it did then.
 */
export const currentAction = (action, startedAt) =>
  action && (!startedAt || String(action.at ?? '') >= String(startedAt)) ? action : null;

/**
 * Stored rows carry account IDs only. Names and emails are attached here, at
 * read time, so they are always current and never sit in storage. Each row
 * also gets its reclaim plan from the scan snapshot and the latest action.
 *
 * The plan ignores the protected list on purpose: `isProtected` is reported
 * beside it, so the page can flip protection on one row without reloading
 * everything. The reclaim resolver enforces the list itself.
 */
export async function decorate(rows, context) {
  const [people, meta, protectedList, latest] = await Promise.all([
    fetchUsersBulk(rows.map((r) => r.accountId)),
    getReportMeta(),
    getProtected(),
    getLatestFor(rows.map((r) => r.accountId)),
  ]);
  const me = context?.accountId;
  return rows.map((r) => {
    const plan = planReclaim({
      userGroupIds: r.groups,
      groupsMeta: meta?.groupsMeta ?? {},
      protectedReason: r.accountId === me ? 'self' : null,
      adminGroups: r.adminGroups,
    });
    return {
      ...r,
      displayName: people[r.accountId]?.displayName ?? '(unknown)',
      email: people[r.accountId]?.email ?? null,
      reclaimable: plan.reclaimable,
      reason: reasonText(plan),
      freedProducts: plan.freedProducts,
      removeGroups: plan.remove.map((g) => g.name),
      isProtected: Boolean(protectedList[r.accountId]),
      lastAction: currentAction(latest[r.accountId], meta?.startedAt),
    };
  });
}
