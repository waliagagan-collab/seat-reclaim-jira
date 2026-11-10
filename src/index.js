import ResolverModule from '@forge/resolver';
import { Queue } from '@forge/events';
import {
  getScanState,
  setScanState,
  getReportMeta,
  getReportPage,
  getAllReportRows,
  getReportedIds,
  clearRun,
  getProtected,
  setProtected,
  newEntryId,
  saveEntry,
  dropEntry,
  noteRow,
  getEntry,
  getLogPage,
  getLatestFor,
  getSettings,
  saveSettings,
} from './lib/store.js';
import { fetchUsersBulk, fetchApplicationRoles, wasActiveWithin } from './lib/jira.js';
import { adminOnly } from './lib/admin.js';
import { normaliseDays, isStale, licenseGate, licenseMessage } from './lib/scan.js';
import { normaliseSeatCosts } from './lib/ui.js';
import { decorate, protectedReasonFor } from './lib/decorate.js';
import {
  buildGroupsMeta,
  planReclaim,
  reasonText,
  adminGroupNames,
  fetchUserGroups,
  hasAdminister,
  removeFromGroups,
  freedProductsFrom,
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
export const RECLAIM_BATCH = 3; // small, so a batch always finishes inside the resolver's 25 s limit
// A reclaim that started this recently for the same person is taken to be
// still running (a second click, a second tab). Older than this, it is not.
const IN_FLIGHT_MS = 60_000;

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
    // The activity query is tried for this person before anyone else is checked.
    startedBy: context?.accountId ?? null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    warnings: [],
    seq: 0,
  };
  await setScanState(state);

  try {
    await queue.push({ body: { run: state.run, seq: 0 } });
  } catch (err) {
    // The run is kept and marked paused; the page's status poll sends the
    // first event again.
    const paused = { ...state, paused: true, pauses: 1, pauseReason: String(err?.message ?? err).slice(0, 300) };
    await setScanState(paused);
    return { ok: true, state: paused };
  }
  return { ok: true, state };
});

/**
 * A run whose next event could not be queued waits, with its cursor saved,
 * marked `paused`. Forge refuses a push after 1,000 in one chain of events;
 * a call from the page starts a new chain, so the status poll is what carries
 * a paused run on. The flag is cleared before the push, while no slice is
 * running, so this write cannot collide with a slice's own.
 */
async function resumeScan(state) {
  const claimed = { ...state, paused: false };
  await setScanState(claimed);
  try {
    await queue.push({ body: { run: state.run, seq: state.seq ?? 0 } });
  } catch (err) {
    await setScanState({ ...claimed, paused: true, pauseReason: String(err?.message ?? err).slice(0, 300) });
  }
  return getScanState();
}

define('getStatus', async () => {
  let state = await getScanState();
  if (state?.status === 'running' && state.paused) state = await resumeScan(state);
  const report = await getReportMeta();
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

// --- settings -------------------------------------------------------------------

define('getSettings', async () => ({ ok: true, settings: await getSettings() }));

define('saveSettings', async ({ payload }) => {
  const current = await getSettings();
  const settings = { ...current, seatCosts: normaliseSeatCosts(payload?.seatCosts) };
  return { ok: true, settings: await saveSettings(settings) };
});

// The review request is shown once per site, after the app has done something
// useful. Closing it is remembered here so no admin sees it again.
define('hideReviewPrompt', async () => {
  const current = await getSettings();
  await saveSettings({ ...current, reviewPromptHiddenAt: new Date().toISOString() });
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
 * Reclaim seats for up to RECLAIM_BATCH accounts. For each one: check they are
 * on the current list and still inactive, read their groups live, make sure
 * they are not an administrator, plan again against a live group map (the
 * scan is a snapshot), leave the planned groups as the signed-in admin, and
 * log exactly what changed.
 */
define('reclaim', async ({ payload, context }) => {
  const refused = licenseRefusal(context);
  if (refused) return refused;

  const asked = Array.isArray(payload?.accountIds) ? payload.accountIds : [];
  const ids = [...new Set(asked.map(String))].slice(0, RECLAIM_BATCH);
  if (!ids.length) return { ok: false, error: 'No users selected.' };

  const meta = await getReportMeta();
  // A reclaim works from the list a scan produced, never from an account ID
  // the page (or anyone calling this directly) happens to send.
  if (!meta) return { ok: false, error: 'There is no list yet. Run a scan first.' };

  const [protectedList, roles, reported, latest] = await Promise.all([
    getProtected(),
    // Groups added or renamed since the scan would otherwise be missed, and the
    // app would report a seat freed that is not.
    fetchApplicationRoles().catch(() => null),
    getReportedIds(ids),
    getLatestFor(ids),
  ]);
  const groupsMeta = roles?.length ? buildGroupsMeta(roles) : (meta?.groupsMeta ?? {});
  const days = normaliseDays(meta?.days);
  const me = context?.accountId;
  const results = [];
  const skip = (accountId, reason) =>
    results.push({ accountId, ok: false, skipped: true, error: reasonText({ reclaimable: false, reason }) });
  let retryAfter = null;

  for (const accountId of ids) {
    const at = new Date().toISOString();
    try {
      if (!reported.has(accountId)) {
        skip(accountId, 'not-on-list');
        continue;
      }
      // A second click or a second tab: the first call is still at work on
      // this person. The entry carries its own time, so nothing has to expire.
      const last = latest[accountId];
      if (last?.status === 'pending' && Date.now() - Date.parse(last.at) < IN_FLIGHT_MS) {
        skip(accountId, 'in-flight');
        continue;
      }
      // The list may be weeks old. Someone who has used Jira since the scan is
      // no longer inactive, whatever the list says.
      if (await wasActiveWithin(accountId, days)) {
        skip(accountId, 'active-since-scan');
        continue;
      }
      const userGroups = await fetchUserGroups(accountId);
      const plan = planReclaim({
        userGroupIds: userGroups.map((g) => g.groupId),
        groupsMeta,
        protectedReason: protectedReasonFor(accountId, protectedList, me),
        // Every group the person is in, not only the ones that grant a product.
        adminGroups: adminGroupNames(userGroups.map((g) => g.name)),
      });
      if (!plan.reclaimable) {
        results.push({ accountId, ok: false, skipped: true, error: reasonText(plan) });
        if (plan.reason === 'admin') await noteRow(accountId, 'blocked', reasonText(plan)).catch(() => {});
        continue;
      }
      // Jira's own answer on whether this person is an administrator. Anything
      // but a clear "no" leaves them alone.
      const admin = await hasAdminister(accountId);
      if (admin !== false) {
        const reason = admin === true ? 'jira-admin' : 'admin-unconfirmed';
        skip(accountId, reason);
        if (admin === true) await noteRow(accountId, 'blocked', reasonText({ reclaimable: false, reason })).catch(() => {});
        continue;
      }
      // The log entry is written BEFORE anything changes, as "pending", so a
      // timeout or dropped connection mid-way can never leave a removed group
      // with no record and no undo. It is updated once Jira has answered.
      const entry = {
        id: newEntryId(),
        type: 'reclaim',
        accountId,
        by: me ?? null,
        at,
        updatedAt: at,
        status: 'pending',
        freedProducts: [],
        keptProducts: plan.keptProducts,
        groups: plan.remove.map((g) => ({ groupId: g.groupId, name: g.name, products: g.products, ok: false, pending: true })),
        days: meta?.days ?? null,
      };
      await saveEntry(entry);

      const changes = await removeFromGroups(accountId, plan.remove);
      const okCount = changes.filter((c) => c.ok).length;
      const unknownCount = changes.filter((c) => c.unknown).length;
      const failedChange = changes.find((c) => !c.ok);
      for (const c of changes) if (c.retryAfter) retryAfter = Math.max(retryAfter ?? 0, c.retryAfter);
      entry.groups = changes;
      entry.freedProducts = freedProductsFrom(changes, plan.keptProducts);
      entry.updatedAt = new Date().toISOString();
      entry.status = okCount === changes.length ? 'reclaimed' : okCount || unknownCount ? 'partial' : 'failed';
      let logged = true;
      try {
        if (entry.status === 'failed') {
          // Nothing was left and nothing is in doubt, so there is nothing to
          // undo: the reason goes on the person's row and History keeps only
          // real changes. A group managed by an identity provider will refuse
          // every time, so that row stops being offered.
          const everyRefusalIsIdp = changes.every((c) => c.idpManaged);
          try {
            await noteRow(accountId, everyRefusalIsIdp ? 'blocked' : 'failed', failedChange?.error ?? null);
            await dropEntry(entry);
          } catch {
            // The note or the removal could not be stored: keep the entry, as
            // "Not done", rather than leave it reading "Interrupted".
            await saveEntry(entry);
            logged = false;
          }
        } else {
          await saveEntry(entry);
        }
      } catch {
        logged = false;
      }
      results.push({
        accountId,
        ok: okCount === changes.length,
        partial: okCount > 0 && okCount < changes.length,
        // Jira asked for a pause before the first group: nothing changed, so
        // the page sends this person again after the wait.
        retry: changes.length > 0 && changes.every((c) => c.rateLimited),
        entryId: entry.status === 'failed' && logged ? null : entry.id,
        freedProducts: entry.freedProducts,
        groupsLeft: changes.filter((c) => c.ok).map((c) => c.name),
        error:
          !logged && okCount
            ? "The groups were left, but the change could not be written to History. Check the person's groups in Atlassian Administration."
            : (failedChange?.error ?? null),
      });
    } catch (err) {
      if (err?.rateLimited) {
        // Jira asked for a pause before anything changed for this person.
        // They, and everyone after them in the batch, are handed back to the
        // page to send again after the wait.
        retryAfter = Math.max(retryAfter ?? 0, err.retryAfter ?? 5);
        for (const rest of ids.slice(ids.indexOf(accountId))) {
          results.push({ accountId: rest, ok: false, retry: true, error: 'Jira asked the app to slow down. Nothing was changed for this person.' });
        }
        break;
      }
      results.push({ accountId, ok: false, error: String(err?.message ?? err) });
    }
  }

  // The names are for the result message only. The changes are already made
  // and logged, so a failed lookup must not turn the whole answer into an error.
  let people = null;
  try {
    people = await fetchUsersBulk(ids);
  } catch {
    /* the page shows the names it already has */
  }
  return {
    ok: true,
    retryAfter,
    results: results.map((r) => ({
      ...r,
      displayName: people ? (people[r.accountId]?.displayName ?? '(unknown)') : null,
    })),
  };
});

/**
 * Put a user back in exactly the groups one reclaim removed. Deliberately not
 * behind the licence gate: a site whose subscription lapsed must still be able
 * to give people their access back.
 */
define('undo', async ({ payload, context }) => {
  const entry = await getEntry(String(payload?.entryId ?? ''));
  if (!entry || entry.type !== 'reclaim') return { ok: false, error: 'That action was not found.' };
  if (entry.status === 'restored') return { ok: true, already: true };

  // Groups that were left, plus any whose removal got no answer or was
  // interrupted: adding someone who is still a member is harmless.
  const removed = (entry.groups ?? []).filter((g) => g.ok || g.unknown || g.pending);
  if (!removed.length) return { ok: false, error: 'That action changed nothing, so there is nothing to undo.' };
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
