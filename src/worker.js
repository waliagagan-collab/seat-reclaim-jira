import api, { route } from '@forge/api';
import { Queue, InvocationError, InvocationErrorCode } from '@forge/events';
import {
  fetchApplicationRoles,
  fetchGroupMemberPage,
  fetchDirectoryPage,
  fetchActivityPage,
  verifyCandidate,
  wasActiveWithin,
} from './lib/jira.js';
import {
  SHARDS,
  getScanState,
  setScanState,
  upsertUsers,
  markActive,
  getShardUsers,
  getShardActive,
  appendDormant,
  buildReport,
  clearRun,
} from './lib/store.js';
import { buildGroupsMeta, adminGroupNames } from './lib/reclaim.js';

const queue = new Queue({ key: 'scan-queue' });

/**
 * The scan is a state machine driven by the async event queue:
 *
 *   roles -> members -> issues -> verify -> finalize
 *
 * Each invocation does a bounded slice, commits its cursor, and re-queues
 * itself. Work inside a slice is accumulated in memory and written to storage
 * ONCE at the end, so a slice costs a handful of storage operations, not
 * hundreds. If a slice dies mid-way, the next event resumes from the last
 * committed cursor; every write is idempotent, so replaying is safe.
 */
// Forge stops a chain of queue events after 1,000 pushes, so a slice does as
// much as its time allows: the manifest gives the function 300 seconds and a
// slice stops itself at 240. The counts below only bound what one slice holds
// in memory before it writes.
const SLICE = {
  memberPages: 200,
  directoryPages: 120,
  issuePages: 75,
  verifyUsers: 250,
  softBudgetMs: 240_000, // stop early; the manifest gives the function 300s
};
const DIRECTORY_PAGE = 200;
const ISSUE_PAGE = 50;
const MAX_ISSUE_PAGES = 400; // sweep ceiling; verify makes a partial sweep harmless
const MAX_TRANSIENT_RETRIES = 6;

export const SWEEP_TRUNCATED_WARNING =
  `This site had more than ${MAX_ISSUE_PAGES * ISSUE_PAGE} issues updated in the window, so the activity sweep stopped at the most recent ${MAX_ISSUE_PAGES * ISSUE_PAGE}. Every remaining user was still checked individually against all issues the app can see, comments included, so the list is unaffected — the scan just took longer.`;

export const uncheckedWarning = (n) =>
  `${n} ${n === 1 ? 'user' : 'users'} could not be checked: Jira rejected the activity query for ${n === 1 ? 'that account' : 'those accounts'}. ${n === 1 ? 'That user is' : 'They are'} not on the list and cannot be reclaimed.`;

const now = () => Date.now();
const overBudget = (t0) => now() - t0 > SLICE.softBudgetMs;

// @forge/events v2+ invokes a consumer function directly with an AsyncEvent;
// the pushed payload is on `event.body`. Resolvers are not used here.
export async function handler(event) {
  const body = event?.body ?? {};
  const state = await getScanState();
  if (!state || state.status !== 'running' || state.run !== body.run) {
    return; // superseded or cancelled: drop the event, do not re-queue
  }
  // Events are delivered at least once. Every commit bumps `seq` and sends it
  // with the next event, so a duplicate or late copy is dropped instead of
  // running the slice twice and forking the scan.
  if ((body.seq ?? 0) !== (state.seq ?? 0)) return;

  try {
    let live;
    switch (state.phase) {
      case 'roles':
        live = await doRoles(state);
        break;
      case 'members':
        live = await doMembers(state);
        break;
      case 'directory':
        live = await doDirectory(state);
        break;
      case 'issues':
        live = await doIssues(state);
        break;
      case 'verify':
        live = await doVerify(state);
        break;
      case 'finalize':
        live = await doFinalize(state);
        break;
      default:
        return await fail(state, `Unknown scan phase "${state.phase}"`);
    }
    // A cancel or a new scan landed while this slice ran: its scratch writes
    // would otherwise sit in storage for ever. (`null` is different: another
    // copy of this slice committed first and the run goes on, so nothing is
    // deleted.)
    if (live === false) await clearRun(state.run);
    return undefined;
  } catch (err) {
    if (err.rateLimited) {
      return new InvocationError({
        retryAfter: err.retryAfter,
        retryReason: InvocationErrorCode.FUNCTION_UPSTREAM_RATE_LIMITED,
      });
    }
    // Nothing was committed, so a retry resumes from the last good cursor.
    // Bounded: a Jira outage should surface as a failed scan, not a scan that
    // spins for the whole retention window.
    const retries = event?.retryContext?.retryCount ?? 0;
    if (err.retryable && retries < MAX_TRANSIENT_RETRIES) {
      return new InvocationError({
        retryAfter: 15 * (retries + 1),
        retryReason: InvocationErrorCode.FUNCTION_RETRY_REQUEST,
      });
    }
    return fail(state, String(err?.message ?? err));
  }
}

/**
 * Commit a patch only if this run is still the live one. A cancel that lands
 * mid-slice must win; without this check the slice would overwrite it with
 * its stale `status: 'running'` snapshot and carry on.
 *
 * Returns true when the patch was written, false when the run is over
 * (cancelled or replaced), and null when another copy of this slice has
 * already committed: queue events are delivered at least once, and two copies
 * can start before either commits. The late copy writes nothing and pushes
 * nothing.
 */
async function commit(state, patch, { requeue = true } = {}) {
  const fresh = await getScanState();
  if (!fresh || fresh.run !== state.run || fresh.status !== 'running') {
    // This slice's scratch writes belong to a run nobody will finish.
    await clearRun(state.run);
    return false;
  }
  if ((fresh.seq ?? 0) !== (state.seq ?? 0)) return null;
  // The seq only moves when a new event is sent; a pause (rate limit) keeps
  // it, so the platform's retry of the same event is still accepted.
  const seq = requeue ? (fresh.seq ?? 0) + 1 : (fresh.seq ?? 0);
  const next = { ...fresh, ...patch, seq, paused: false };
  await setScanState(next);
  if (requeue) {
    try {
      await queue.push({ body: { run: state.run, seq } });
    } catch (err) {
      // The cursor is saved, so nothing is lost. Forge refuses the push after
      // 1,000 in one chain; any other failure is treated the same. The run is
      // marked paused, and the page's status poll (a fresh chain) sends the
      // next event.
      await setScanState({
        ...next,
        paused: true,
        pauses: (next.pauses ?? 0) + 1,
        pauseReason: String(err?.message ?? err).slice(0, 300),
      });
    }
  }
  return true;
}

/**
 * A rate limit mid-slice: save what the slice collected so far, commit the
 * cursor without re-queueing, then rethrow so the handler asks the platform
 * to retry after Retry-After. The retry resumes from the committed cursor.
 */
async function pause(state, patch, err) {
  await commit(state, patch, { requeue: false });
  throw err;
}

async function fail(state, error) {
  const fresh = await getScanState();
  if (!fresh || fresh.run !== state.run || fresh.status !== 'running') return;
  // A late copy of a slice must not fail a run that has moved on without it.
  if ((fresh.seq ?? 0) !== (state.seq ?? 0)) return;
  await setScanState({
    ...fresh,
    status: 'failed',
    error,
    finishedAt: new Date().toISOString(),
  });
  // Scratch data from a failed run has no further use; do not leave it behind.
  await clearRun(state.run);
}

// --- roles ------------------------------------------------------------------

async function doRoles(state) {
  let roles;
  try {
    roles = await fetchApplicationRoles();
  } catch (err) {
    if (err.status === 401 || err.status === 403 || err.status === 404) {
      // Can't see licensing groups: degrade to the site directory and say so.
      return commit(state, {
        phase: 'directory',
        userSource: 'directory',
        warnings: [
          ...(state.warnings ?? []),
          'The app could not read which groups give each Jira product, so this list covers everyone in the site directory. It may include people who hold no Jira seat, and nobody on it can be reclaimed.',
        ],
        directoryCursor: 0,
      });
    }
    throw err;
  }

  if (!roles.length) {
    return commit(state, {
      phase: 'directory',
      userSource: 'directory',
      warnings: [
        ...(state.warnings ?? []),
        'Jira reported no product access groups, so this list covers everyone in the site directory. Nobody on it can be reclaimed.',
      ],
      directoryCursor: 0,
    });
  }

  const groupQueue = roles.flatMap((r) =>
    r.groups.map((g) => ({
      groupId: g.groupId,
      groupName: g.name,
      roleKey: r.key,
      roleName: r.name,
      startAt: 0,
    }))
  );

  return commit(state, {
    phase: 'members',
    userSource: 'roles',
    products: roles.map(({ groups, ...r }) => r),
    // Which group grants which products. Reclaim plans are built from this.
    groupsMeta: buildGroupsMeta(roles),
    groupQueue,
    usersFound: 0,
  });
}

// --- members ----------------------------------------------------------------

async function doMembers(state) {
  const t0 = now();
  const groupQueue = [...(state.groupQueue ?? [])];
  const collected = [];

  let paused = null;
  for (let i = 0; i < SLICE.memberPages && groupQueue.length && !overBudget(t0); i++) {
    const head = groupQueue[0];
    let page;
    try {
      page = await fetchGroupMemberPage(head.groupId, head.startAt);
    } catch (err) {
      if (err.rateLimited) {
        paused = err;
        break;
      }
      throw err;
    }
    for (const u of page.users) {
      collected.push({ ...u, products: [head.roleName], groups: [head.groupId] });
    }
    if (page.isLast) groupQueue.shift();
    else groupQueue[0] = { ...head, startAt: page.nextStartAt };
  }

  if (collected.length) await upsertUsers(state.run, collected);

  const usersFound = (state.usersFound ?? 0) + collected.length;
  const done = groupQueue.length === 0 && !paused;
  const patch = {
    groupQueue,
    usersFound,
    phase: done ? 'issues' : 'members',
    ...(done ? { issueToken: null, issuePages: 0, issuesScanned: 0 } : {}),
  };
  if (paused) return pause(state, patch, paused);
  return commit(state, patch);
}

// --- directory (fallback) ---------------------------------------------------

async function doDirectory(state) {
  const t0 = now();
  let startAt = state.directoryCursor ?? 0;
  let isLast = false;
  const collected = [];

  let paused = null;
  for (let i = 0; i < SLICE.directoryPages && !overBudget(t0); i++) {
    let page;
    try {
      page = await fetchDirectoryPage(startAt, DIRECTORY_PAGE);
    } catch (err) {
      if (err.rateLimited) {
        paused = err;
        break;
      }
      throw err;
    }
    for (const u of page.users) collected.push({ ...u, products: ['Jira'] });
    startAt = page.nextStartAt;
    if (page.isLast) {
      isLast = true;
      break;
    }
  }

  if (collected.length) await upsertUsers(state.run, collected);

  const patch = {
    directoryCursor: startAt,
    usersFound: (state.usersFound ?? 0) + collected.length,
    phase: isLast ? 'issues' : 'directory',
    ...(isLast ? { issueToken: null, issuePages: 0, issuesScanned: 0 } : {}),
  };
  if (paused) return pause(state, patch, paused);
  return commit(state, patch);
}

// --- issues (sweep) ---------------------------------------------------------

async function doIssues(state) {
  const t0 = now();
  let token = state.issueToken ?? null;
  let pages = state.issuePages ?? 0;
  let scanned = state.issuesScanned ?? 0;
  let done = false;
  let truncated = false;
  const active = new Set();

  let paused = null;
  for (let i = 0; i < SLICE.issuePages && !overBudget(t0); i++) {
    let page;
    try {
      page = await fetchActivityPage(state.days, token, ISSUE_PAGE);
    } catch (err) {
      if (err.rateLimited) {
        paused = err;
        break;
      }
      throw err;
    }
    for (const id of Object.keys(page.activity)) active.add(id);
    scanned += page.count;
    pages += 1;
    token = page.nextPageToken;

    if (page.isLast) {
      done = true;
      break;
    }
    if (pages >= MAX_ISSUE_PAGES) {
      done = true;
      truncated = true;
      break;
    }
  }

  if (active.size) await markActive(state.run, [...active]);

  const patch = {
    issueToken: token,
    issuePages: pages,
    issuesScanned: scanned,
    sweepTruncated: Boolean(state.sweepTruncated) || truncated,
    phase: done ? 'verify' : 'issues',
    ...(done ? { verifyShard: 0, verifyIndex: 0, verified: 0, dormantFound: 0, unchecked: 0 } : {}),
  };
  if (paused) return pause(state, patch, paused);
  return commit(state, patch);
}

// --- verify -----------------------------------------------------------------

/**
 * The admin-like names among ALL of a user's groups, read as the app (there
 * is no signed-in user in a background slice). The page uses them to show
 * "Can't reclaim" for anyone in an admin group, whatever that group grants.
 * null when Jira would not say; the reclaim step reads the groups again, live
 * and as the admin, and asks Jira whether the person is an administrator.
 */
async function readAdminGroups(accountId) {
  let res;
  try {
    res = await api
      .asApp()
      .requestJira(route`/rest/api/3/user/groups?accountId=${accountId}`, { headers: { Accept: 'application/json' } });
  } catch (err) {
    err.retryable = true;
    throw err;
  }
  if (res.status === 429) {
    const err = new Error('Rate limited by Jira');
    err.rateLimited = true;
    err.retryAfter = Math.max(1, Number(res.headers.get('Retry-After')) || 5);
    throw err;
  }
  if (res.status >= 500) {
    const err = new Error(`Jira returned ${res.status}`);
    err.retryable = true;
    throw err;
  }
  if (!res.ok) return null;
  const rows = (await res.json()) ?? [];
  return adminGroupNames((Array.isArray(rows) ? rows : []).map((g) => g?.name));
}

/**
 * For every user the sweep could not vouch for, ask Jira directly. This is
 * exhaustive across all issues, so it is correct even when the sweep was
 * truncated — the sweep only decides how much verification is needed.
 */
async function doVerify(state) {
  const t0 = now();
  let shard = state.verifyShard ?? 0;
  let index = state.verifyIndex ?? 0;
  let verified = state.verified ?? 0;
  let dormantFound = state.dormantFound ?? 0;
  let unchecked = state.unchecked ?? 0;
  let checked = 0;
  let paused = null;

  // Before anyone is checked, run the query once for the person who started
  // the scan. If Jira rejects it for them too (even without the work log
  // clause), it would reject it for everyone: say so now, with Jira's
  // message, rather than end with a list of people who were not checked.
  if (!state.queryChecked && state.startedBy) {
    try {
      await wasActiveWithin(state.startedBy, state.days);
    } catch (err) {
      if (err.rateLimited) return pause(state, {}, err);
      if (err.status !== 400) throw err;
      await fail(state, err.message);
      return true;
    }
  }

  while (shard < SHARDS && checked < SLICE.verifyUsers && !overBudget(t0) && !paused) {
    const users = await getShardUsers(state.run, shard);
    const activeSet = await getShardActive(state.run, shard);
    const ids = Object.keys(users).sort();
    const dormantRows = [];

    while (index < ids.length && checked < SLICE.verifyUsers && !overBudget(t0)) {
      const accountId = ids[index];
      if (activeSet[accountId]) {
        index += 1;
        continue; // sweep already proved them active
      }

      let result;
      let adminGroups = null;
      try {
        result = await verifyCandidate(accountId, state.days);
        if (!result.active) adminGroups = await readAdminGroups(accountId);
      } catch (err) {
        if (err.rateLimited) {
          paused = err; // this user is re-verified when the slice resumes
          break;
        }
        if (err.status === 400) {
          // Jira rejected the query for this account, even without the work
          // log clause (removed since the listing, or an unusual id). Not
          // checked: counted and reported, never listed as inactive on a
          // guess, and so never offered for reclaim.
          result = { active: true, unchecked: true };
        } else {
          throw err;
        }
      }
      index += 1;
      checked += 1;
      verified += 1;
      if (result.unchecked) unchecked += 1;
      if (!result.active) {
        dormantFound += 1;
        dormantRows.push({
          accountId,
          products: users[accountId].products,
          groups: users[accountId].groups ?? [],
          ...(adminGroups?.length ? { adminGroups } : {}),
          bucket: result.bucket,
          label: result.label,
          severity: result.severity,
        });
      }
    }

    if (dormantRows.length) await appendDormant(state.run, shard, dormantRows);

    if (index >= ids.length) {
      shard += 1;
      index = 0;
    }
  }

  const done = shard >= SHARDS && !paused;
  const patch = {
    verifyShard: shard,
    verifyIndex: index,
    verified,
    dormantFound,
    unchecked,
    queryChecked: true,
    phase: done ? 'finalize' : 'verify',
  };
  if (paused) return pause(state, patch, paused);
  return commit(state, patch);
}

// --- finalize ---------------------------------------------------------------

async function doFinalize(state) {
  // Count seats from the stored user map so the total matches what was audited.
  let totalUsers = 0;
  const licensedByProduct = {};
  for (let s = 0; s < SHARDS; s++) {
    const users = await getShardUsers(state.run, s);
    for (const u of Object.values(users)) {
      totalUsers += 1;
      for (const p of u.products ?? []) licensedByProduct[p] = (licensedByProduct[p] ?? 0) + 1;
    }
  }

  const unchecked = state.unchecked ?? 0;
  const report = await buildReport(
    state.run,
    {
      days: state.days,
      // When the scan started: an action on a user from before this moment
      // says nothing about a row of this report.
      startedAt: state.startedAt ?? null,
      userSource: state.userSource ?? 'roles',
      products: state.products ?? [],
      groupsMeta: state.groupsMeta ?? {},
      licensedByProduct,
      totalUsers,
      activeUsers: totalUsers - (state.dormantFound ?? 0) - unchecked,
      unchecked,
      verified: state.verified ?? 0,
      issuesScanned: state.issuesScanned ?? 0,
      sweepTruncated: Boolean(state.sweepTruncated),
      warnings: [
        ...(state.warnings ?? []),
        ...(state.sweepTruncated ? [SWEEP_TRUNCATED_WARNING] : []),
        ...(unchecked ? [uncheckedWarning(unchecked)] : []),
      ],
    },
    {
      // Asked after the scratch data was read and before the report is
      // written: a late copy of this slice must not publish.
      confirm: async () => {
        const fresh = await getScanState();
        return Boolean(fresh && fresh.run === state.run && fresh.status === 'running' && (fresh.seq ?? 0) === (state.seq ?? 0));
      },
    }
  );
  if (!report) return null;

  const closed = await commit(
    state,
    { status: 'complete', phase: 'done', finishedAt: report.generatedAt },
    { requeue: false }
  );
  // The scratch data goes only once the report is out and the run is closed,
  // so a second copy of this slice never reads half-deleted data.
  if (closed === true) await clearRun(state.run);
  return closed;
}
