import ResolverModule from '@forge/resolver';
import { Queue } from '@forge/events';
import {
  getScanState,
  setScanState,
  getReportMeta,
  getReportPage,
  getAllReportRows,
  clearRun,
  getProtected,
  setProtected,
  newEntryId,
  saveEntry,
  getEntry,
  getLogPage,
  getLatestFor,
} from './lib/store.js';
import { fetchUsersBulk, fetchApplicationRoles } from './lib/jira.js';
import { adminOnly } from './lib/admin.js';
import { normaliseDays, isStale, licenseGate, licenseMessage } from './lib/scan.js';
import {
  planReclaim,
  reasonText,
  fetchUserGroupIds,
  removeFromGroups,
  addToGroups,
} from './lib/reclaim.js';

// Forge bundles this ESM file with webpack, and the CommonJS `@forge/resolver`
// arrives as a namespace object rather than the class. Take the default when
// one is present, so this works under either interop.
const Resolver = ResolverModule?.default ?? ResolverModule;

const resolver = new Resolver();

// Every resolver is admin-only. Defining through this helper means a new
// resolver can't be added without the check.
const define = (key, fn) => resolver.define(key, adminOnly(fn));
const queue = new Queue({ key: 'scan-queue' });

const EXPORT_LIMIT = 5000;
// A resolver call has a hard time limit, so reclaim runs in small batches and
// the page loops. Each user costs one read plus one call per group.
export const RECLAIM_BATCH = 5;

/** Who is protected from reclaim, and why. */
const protectedReasonFor = (accountId, protectedList, me) =>
  accountId === me ? 'self' : protectedList[accountId] ? 'protected' : null;

/**
 * Stored rows carry account IDs only. Names and emails are attached here, at
 * read time, so they are always current and never sit in storage. Each row
 * also gets its reclaim plan from the scan snapshot and the latest action.
 */
async function decorate(rows, context) {
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

const licenseRefusal = (context) => {
  const gate = licenseGate(context?.license, context?.environmentType);
  return gate.allowed
    ? null
    : { ok: false, unlicensed: true, error: licenseMessage(gate, context?.license) };
};

// --- scan ---------------------------------------------------------------------

define('startScan', async ({ payload, context }) => {
  // The frontend gates too, but a resolver can be invoked directly, so the
  // paid-app check is enforced here as well. Non-production is never blocked.
  const refused = licenseRefusal(context);
  if (refused) return refused;

  const days = normaliseDays(payload?.days);

  const existing = await getScanState();
  if (existing?.status === 'running' && !isStale(existing)) {
    return { ok: false, error: 'A scan is already running.' };
  }
  if (existing?.run) await clearRun(existing.run);

  const state = {
    run: `${Date.now()}`,
    status: 'running',
    phase: 'roles',
    days,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    warnings: [],
  };
  await setScanState(state);

  try {
    await queue.push({ body: { run: state.run } });
  } catch (err) {
    await setScanState({
      ...state,
      status: 'error',
      phase: 'failed',
      finishedAt: new Date().toISOString(),
      error: `Could not queue the scan: ${err?.message ?? err}`,
    });
    return { ok: false, error: 'Could not start the scan. Please try again.' };
  }
  return { ok: true, state };
});

define('getStatus', async () => {
  const [state, report] = await Promise.all([getScanState(), getReportMeta()]);
  return { ok: true, state: state ?? null, stale: isStale(state), report: report ?? null };
});

define('getPage', async ({ payload, context }) => {
  const index = Math.max(0, Number(payload?.index) || 0);
  return { ok: true, index, rows: await decorate(await getReportPage(index), context) };
});

define('getAllRows', async ({ context }) => ({
  ok: true,
  rows: await decorate(await getAllReportRows(EXPORT_LIMIT), context),
  limit: EXPORT_LIMIT,
}));

define('cancelScan', async () => {
  const state = await getScanState();
  if (state?.status === 'running') {
    await setScanState({ ...state, status: 'cancelled', finishedAt: new Date().toISOString() });
    await clearRun(state.run);
  }
  return { ok: true };
});

// --- seats --------------------------------------------------------------------

/** Atlassian's own seat counts, read fresh. Shown before and after a reclaim. */
define('getSeatCounts', async () => {
  const roles = await fetchApplicationRoles();
  return {
    ok: true,
    at: new Date().toISOString(),
    products: roles.map((r) => ({ key: r.key, name: r.name, userCount: r.userCount })),
  };
});

// --- protected list -------------------------------------------------------------

define('setProtected', async ({ payload, context }) => {
  const accountId = String(payload?.accountId ?? '');
  if (!accountId) return { ok: false, error: 'No account given.' };
  await setProtected(accountId, Boolean(payload?.protected), context?.accountId ?? null);
  return { ok: true };
});

// --- reclaim and undo -------------------------------------------------------------

/**
 * Reclaim seats for up to RECLAIM_BATCH accounts. For each one: read their
 * groups live, plan again (the snapshot may be out of date), leave the planned
 * groups as the signed-in admin, and log exactly what changed.
 */
define('reclaim', async ({ payload, context }) => {
  const refused = licenseRefusal(context);
  if (refused) return refused;

  const ids = [...new Set((payload?.accountIds ?? []).map(String))].slice(0, RECLAIM_BATCH);
  if (!ids.length) return { ok: false, error: 'No users selected.' };

  const [meta, protectedList] = await Promise.all([getReportMeta(), getProtected()]);
  const groupsMeta = meta?.groupsMeta ?? {};
  const me = context?.accountId;
  const results = [];

  for (const accountId of ids) {
    const at = new Date().toISOString();
    try {
      const plan = planReclaim({
        userGroupIds: await fetchUserGroupIds(accountId),
        groupsMeta,
        protectedReason: protectedReasonFor(accountId, protectedList, me),
      });
      if (!plan.reclaimable) {
        results.push({ accountId, ok: false, skipped: true, error: reasonText(plan) });
        continue;
      }
      const changes = await removeFromGroups(accountId, plan.remove);
      const okCount = changes.filter((c) => c.ok).length;
      const entry = {
        id: newEntryId(),
        type: 'reclaim',
        accountId,
        by: me ?? null,
        at,
        updatedAt: at,
        status: okCount === changes.length ? 'reclaimed' : okCount ? 'partial' : 'failed',
        freedProducts: plan.freedProducts,
        keptProducts: plan.keptProducts,
        groups: changes,
        days: meta?.days ?? null,
      };
      if (okCount) await saveEntry(entry); // nothing changed, nothing to undo
      results.push({
        accountId,
        ok: okCount === changes.length,
        entryId: okCount ? entry.id : null,
        freedProducts: plan.freedProducts,
        error: changes.find((c) => !c.ok)?.error ?? null,
      });
    } catch (err) {
      results.push({ accountId, ok: false, error: String(err?.message ?? err) });
    }
  }

  const people = await fetchUsersBulk(ids);
  return {
    ok: true,
    results: results.map((r) => ({ ...r, displayName: people[r.accountId]?.displayName ?? '(unknown)' })),
  };
});

/** Put a user back in exactly the groups one reclaim removed. */
define('undo', async ({ payload, context }) => {
  const entry = await getEntry(String(payload?.entryId ?? ''));
  if (!entry || entry.type !== 'reclaim') return { ok: false, error: 'That action was not found.' };
  if (entry.status === 'restored') return { ok: true, already: true };

  const removed = (entry.groups ?? []).filter((g) => g.ok);
  const changes = await addToGroups(entry.accountId, removed);
  const allBack = changes.every((c) => c.ok);
  const at = new Date().toISOString();
  const updated = {
    ...entry,
    status: allBack ? 'restored' : entry.status,
    updatedAt: at,
    restoredAt: allBack ? at : null,
    restoredBy: allBack ? (context?.accountId ?? null) : null,
    restoreErrors: allBack ? [] : changes.filter((c) => !c.ok).map((c) => `${c.name}: ${c.error}`),
  };
  await saveEntry(updated);
  return { ok: allBack, error: allBack ? null : updated.restoreErrors.join(' ') };
});

define('getHistory', async ({ payload }) => {
  const page = Math.max(0, Number(payload?.page) || 0);
  const { entries, total, pages } = await getLogPage(page);
  const people = await fetchUsersBulk(entries.flatMap((e) => [e.accountId, e.by, e.restoredBy]));
  const name = (id) => (id ? (people[id]?.displayName ?? '(unknown)') : null);
  return {
    ok: true,
    page,
    pages,
    total,
    entries: entries.map((e) => ({
      ...e,
      displayName: name(e.accountId),
      byName: name(e.by),
      restoredByName: name(e.restoredBy),
    })),
  };
});

export const handler = resolver.getDefinitions();
