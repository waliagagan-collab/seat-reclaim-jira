/**
 * Pure helpers for the Rovo agent. The agent reads the last scan, the reclaim
 * plan and the action log. It never reclaims or undoes anything: that happens
 * only on the Seat Reclaim page, after the admin confirms. No Forge imports,
 * so these rules run under plain Node tests.
 */
import { yearlySaving } from './ui.js';

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
export const HISTORY_DEFAULT = 10;
export const HISTORY_MAX = 25;

export const NO_REPORT =
  'No scan has been run on this site yet. A Jira admin can run one in Jira settings → Apps → Seat Reclaim; it takes a few minutes.';

const text = (v) => String(v ?? '').trim();

/** Pure: a positive number from whatever the agent sends ("180", 180, "180 days"), else null. */
export function positive(v) {
  const m = String(v ?? '').match(/-?\d+(\.\d+)?/);
  const n = m ? Number(m[0]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Pure: the lower bound in days of a stored band, e.g. '90-180' -> 90, 'over-365' -> 365. */
export function bandFloor(bucket) {
  const m = String(bucket ?? '').match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

const ALIASES = {
  jsm: 'service',
  jsd: 'service',
  'service management': 'service',
  'service desk': 'service',
  jpd: 'product discovery',
  jwm: 'work management',
  jcs: 'customer service',
};
const productKey = (s) => text(s).toLowerCase().replace(/^jira\s+/, '');

/** Pure: does a product name match what the admin typed ("JSM", "software", "Jira Software")? */
export function matchProduct(query, name) {
  const raw = productKey(query);
  if (!raw) return true;
  const q = ALIASES[raw] ?? raw;
  const n = productKey(name);
  return n.includes(q) || q.includes(n);
}

/** Pure: the same three groups the page's status filter uses. */
export function statusOf(u) {
  if (u?.lastAction?.status === 'reclaimed') return 'reclaimed';
  return u?.reclaimable && !u?.isProtected ? 'ready' : 'blocked';
}

/** Pure: why a blocked user is blocked, with the protected list applied. */
export const blockReason = (u) => (u?.isProtected ? 'On your protected list.' : (u?.reason ?? 'Cannot be reclaimed.'));

const STATUS_WORDS = { ready: 'Ready to reclaim', blocked: "Can't reclaim", reclaimed: 'Already reclaimed' };

/** Pure: what the admin typed for a status -> ready | blocked | reclaimed | null (all). */
export function normaliseStatus(v) {
  const s = text(v).toLowerCase();
  if (!s || /all|any|every/.test(s)) return null;
  // "already" contains "ready", so it is checked first.
  if (/already|done|removed|previously/.test(s)) return 'reclaimed';
  if (/can'?t|cannot|blocked|\bnot\b|admin|protect/.test(s)) return 'blocked';
  if (/ready|\bcan\b|eligible|reclaimable/.test(s)) return 'ready';
  if (/reclaimed/.test(s)) return 'reclaimed';
  return null;
}

/** Pure: the list action's inputs, cleaned and capped. */
export function listOptions(payload) {
  return {
    status: normaliseStatus(payload?.status),
    search: text(payload?.search).slice(0, 100),
    product: text(payload?.product).slice(0, 100),
    minDays: positive(payload?.minimumDaysInactive),
    limit: Math.min(MAX_LIMIT, Math.max(1, Math.round(positive(payload?.limit) ?? DEFAULT_LIMIT))),
  };
}

/** Pure: filters over decorated rows (they already carry names and plans). */
export function filterCandidates(rows, { status, search, product, minDays }) {
  const q = text(search).toLowerCase();
  return (rows ?? []).filter(
    (u) =>
      (!status || statusOf(u) === status) &&
      (!q || `${u.displayName ?? ''} ${u.email ?? ''}`.toLowerCase().includes(q)) &&
      (!product || (u.products ?? []).some((p) => matchProduct(product, p))) &&
      (!minDays || bandFloor(u.bucket) >= minDays)
  );
}

export const stamp = (meta) => ({
  reportGeneratedAt: meta?.generatedAt ?? null,
  scanPeriodDays: meta?.days ?? null,
});

/** Pure: one candidate as the agent shows it. */
export const candidateLine = (u) => ({
  name: u.displayName ?? '(unknown)',
  email: u.email ?? null,
  products: u.products ?? [],
  inactiveFor: u.label ?? null,
  status: STATUS_WORDS[statusOf(u)],
  wouldFree: statusOf(u) === 'ready' ? (u.freedProducts ?? []) : [],
  reason: statusOf(u) === 'blocked' ? blockReason(u) : null,
  partlyReclaimed: u.lastAction?.status === 'partial' || undefined,
});

/** Pure: the reclaim summary over decorated rows. */
export function reclaimSummary(meta, rows, settings, roles = null, product = '') {
  const inScope = (rows ?? []).filter((u) => !product || (u.products ?? []).some((p) => matchProduct(product, p)));
  const groups = { ready: [], blocked: [], reclaimed: [] };
  for (const u of inScope) groups[statusOf(u)].push(u);

  const freed = {};
  for (const u of groups.ready) {
    for (const p of u.freedProducts ?? []) {
      if (matchProduct(product, p)) freed[p] = (freed[p] ?? 0) + 1;
    }
  }
  const reasons = {};
  for (const u of groups.blocked) {
    const r = blockReason(u);
    reasons[r] = (reasons[r] ?? 0) + 1;
  }
  const prices = settings?.seatCosts ?? {};
  return {
    ...stamp(meta),
    inactiveUsers: inScope.length,
    readyToReclaim: groups.ready.length,
    cannotReclaim: groups.blocked.length,
    alreadyReclaimed: groups.reclaimed.length,
    whyNot: Object.entries(reasons).map(([reason, users]) => ({ reason, users })),
    seatsFreedIfAllReadyAreReclaimed: freed,
    // Nothing ready means nothing to save; blank would read as "no price saved".
    estimatedYearlySaving: Object.keys(freed).length ? yearlySaving(freed, prices) : 0,
    productsWithoutAPrice: Object.keys(freed).filter((p) => !(prices[p] > 0)),
    seatsCountedByAtlassianNow: roles
      ? roles.filter((r) => matchProduct(product, r.name)).map((r) => ({ product: r.name, seats: r.userCount ?? null }))
      : null,
    note: 'Reclaiming happens only on the Seat Reclaim page, after you confirm. Every reclaim is logged and can be undone there.',
  };
}

/** Pure: the list action's answer. */
export function listAnswer(meta, opts, matching) {
  const shown = matching.slice(0, opts.limit);
  return {
    ...stamp(meta),
    filters: {
      status: opts.status ? STATUS_WORDS[opts.status] : null,
      search: opts.search || null,
      product: opts.product || null,
      minimumDaysInactive: opts.minDays,
    },
    matchingUsers: matching.length,
    shown: shown.length,
    users: shown.map(candidateLine),
    note:
      matching.length > shown.length
        ? `Showing the first ${shown.length} of ${matching.length}, longest inactive first. Ask for more (up to ${MAX_LIMIT}).`
        : null,
  };
}

const ACTION_WORDS = { reclaimed: 'Reclaimed', partial: 'Partly reclaimed', failed: 'Failed', restored: 'Undone' };

/** Pure: one log entry as the agent shows it; `name` maps account IDs to display names. */
export const historyLine = (e, name) => ({
  user: name(e.accountId),
  outcome: ACTION_WORDS[e.status] ?? e.status ?? null,
  at: e.at ?? null,
  by: name(e.by),
  productsFreed: e.freedProducts ?? [],
  groupsLeft: (e.groups ?? []).filter((g) => g.ok).map((g) => g.name),
  undoneAt: e.restoredAt ?? null,
  undoneBy: e.restoredBy ? name(e.restoredBy) : null,
});

export const historyLimit = (payload) =>
  Math.min(HISTORY_MAX, Math.max(1, Math.round(positive(payload?.limit) ?? HISTORY_DEFAULT)));
