import { getReportMeta, getProtected, getLatestFor } from './store.js';
import { fetchUsersBulk } from './jira.js';
import { planReclaim, reasonText } from './reclaim.js';

/** Who is protected from reclaim, and why. */
export const protectedReasonFor = (accountId, protectedList, me) =>
  accountId === me ? 'self' : protectedList[accountId] ? 'protected' : null;

/**
 * Stored rows carry account IDs only. Names and emails are attached here, at
 * read time, so they are always current and never sit in storage. Each row
 * also gets its reclaim plan from the scan snapshot and the latest action.
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
      protectedReason: protectedReasonFor(r.accountId, protectedList, me),
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
      lastAction: latest[r.accountId] ?? null,
    };
  });
}
