import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeSite } from './fakes/jira-site.js';
import { loadServer, reset, drain, call, stored, ADMIN } from './helpers.js';

/**
 * The background scan on a fake site: the queue worker, slice by slice, with
 * duplicate events, a queue that refuses a push, storage that fails, and Jira
 * rejecting the per-user query.
 */

let server;
let site;

before(async () => {
  server = await loadServer();
});

beforeEach(() => {
  site = makeSite();
  site.addUser(ADMIN, ['g-jsw']);
  site.lastActive[ADMIN] = 1;
  site.addUser('u-idle', ['g-jsw']);
  site.addUser('u-busy', ['g-jsw']);
  site.lastActive['u-busy'] = 3;
  site.addUser('u-two', ['g-jsw', 'g-jsm']);
  reset(site);
});

const state = () => stored('scan:state');
const status = () => call(server, 'getStatus');
const listed = async () => (await call(server, 'getAllRows')).rows.map((r) => r.accountId).sort();

test('two copies of every event still make one correct scan: the copy that commits second writes and pushes nothing', async () => {
  await call(server, 'startScan', { days: 90 });
  let rounds = 0;
  while (globalThis.__queue.length && rounds++ < 50) {
    const events = globalThis.__queue.splice(0);
    assert.equal(events.length, 1, 'one slice pushes one event; the late copy pushes nothing');
    const seqBefore = state().seq;
    // One copy starts and is held at its first call to Jira; the other runs
    // to its commit; then the first is let go and reaches its own commit.
    let release;
    site.holdNext = new Promise((resolve) => (release = resolve));
    const held = server.worker.handler(events[0]);
    await server.worker.handler(events[0]);
    site.holdNext = null;
    release();
    await held;
    assert.ok(state().seq <= seqBefore + 1, 'the sequence number moves once per slice');
  }
  assert.equal(state().status, 'complete');
  const report = (await status()).report;
  assert.equal(report.totalUsers, 4);
  assert.equal(report.dormantCount, 2);
  assert.deepEqual(await listed(), ['u-idle', 'u-two']);
});

test('the last slice run twice publishes one complete report', async () => {
  await call(server, 'startScan', { days: 90 });
  while (state().phase !== 'finalize') await server.worker.handler(globalThis.__queue.shift());
  const event = globalThis.__queue.shift();
  const atStart = state();
  await Promise.all([server.worker.handler(event), server.worker.handler(event)]);
  assert.equal(state().status, 'complete');
  assert.deepEqual(await listed(), ['u-idle', 'u-two']);
  assert.deepEqual([...globalThis.__kvs.keys()].filter((k) => k.startsWith(`scan:${state().run}:`)), [], 'the scratch data is gone once the run is closed');

  // A second copy that started while the run was still open, and gets to its
  // work only after the first copy closed the run and deleted the scratch
  // data, must not publish a report from what is left (nothing).
  globalThis.__kvsOnce = { key: 'scan:state', value: atStart };
  await server.worker.handler(event);
  assert.equal(state().status, 'complete');
  assert.equal((await status()).report.dormantCount, 2);
  assert.deepEqual(await listed(), ['u-idle', 'u-two']);

  // A copy that arrives after the run is closed does nothing at all.
  const writes = globalThis.__kvsWrites.length;
  await server.worker.handler(event);
  assert.equal(globalThis.__kvsWrites.length, writes);
});

test('a late copy of a slice writes nothing once another copy has committed', async () => {
  await call(server, 'startScan', { days: 90 });
  const event = globalThis.__queue.shift();
  await server.worker.handler(event);
  const after = JSON.stringify(state());
  const queued = globalThis.__queue.length;
  await server.worker.handler(event); // the same event again
  assert.equal(JSON.stringify(state()), after);
  assert.equal(globalThis.__queue.length, queued);
});

test('when the queue refuses the next event the run is paused, not failed, and the status poll carries it on', async () => {
  await call(server, 'startScan', { days: 90 });
  await server.worker.handler(globalThis.__queue.shift()); // roles
  globalThis.__queueFail = 1;
  await server.worker.handler(globalThis.__queue.shift()); // members: the push fails
  assert.equal(state().status, 'running');
  assert.equal(state().paused, true);
  assert.equal(state().phase, 'issues', 'the cursor moved on and was saved');
  assert.equal(globalThis.__queue.length, 0);
  assert.ok([...globalThis.__kvs.keys()].some((k) => k.startsWith(`scan:${state().run}:users:`)), 'nothing was deleted');

  const polled = await status(); // the page's poll
  assert.equal(polled.state.paused, false);
  assert.equal(globalThis.__queue.length, 1);
  assert.deepEqual(globalThis.__queue[0].body, { run: state().run, seq: state().seq });
  await drain(server);
  assert.equal(state().status, 'complete');
  assert.deepEqual(await listed(), ['u-idle', 'u-two']);
});

test('a scan whose first event cannot be queued is kept and started by the next status poll', async () => {
  globalThis.__queueFail = 1;
  const started = await call(server, 'startScan', { days: 90 });
  assert.equal(started.ok, true);
  assert.equal(state().paused, true);
  assert.equal(state().status, 'running');
  await status();
  await drain(server);
  assert.equal(state().status, 'complete');
});

test('a storage call that fails twice is tried again and the scan goes on', async () => {
  await call(server, 'startScan', { days: 90 });
  await server.worker.handler(globalThis.__queue.shift()); // roles
  globalThis.__kvsFail = 2;
  await server.worker.handler(globalThis.__queue.shift()); // members
  assert.equal(state().status, 'running');
  await drain(server);
  assert.equal(state().status, 'complete');
  assert.deepEqual(await listed(), ['u-idle', 'u-two']);
});

test('when Jira rejects the query with the work log clause, the user is checked without it', async () => {
  site.rejectWorklog.add('u-idle');
  site.rejectWorklog.add('u-busy');
  await call(server, 'startScan', { days: 90 });
  await drain(server);
  const report = (await status()).report;
  assert.equal(report.unchecked, 0);
  assert.deepEqual(await listed(), ['u-idle', 'u-two']); // u-busy was found active by the second query
});

test('a user Jira will not check at all is counted, reported, left off the list and cannot be reclaimed', async () => {
  site.reject.add('u-idle');
  await call(server, 'startScan', { days: 90 });
  await drain(server);
  const report = (await status()).report;
  assert.equal(state().status, 'complete');
  assert.equal(report.unchecked, 1);
  assert.equal(report.dormantCount, 1);
  assert.equal(report.activeUsers, 2, 'not checked is not counted as active');
  assert.ok(report.warnings.some((w) => /1 user could not be checked/.test(w)));
  assert.deepEqual(await listed(), ['u-two']);
  const res = await call(server, 'reclaim', { accountIds: ['u-idle'] });
  assert.match(res.results[0].error, /Not on the current list/);
  assert.equal(site.removed.length, 0);
});

test('if Jira rejects the query for the person who started the scan, the scan fails with Jira\'s message', async () => {
  site.reject.add(ADMIN);
  await call(server, 'startScan', { days: 90 });
  await drain(server);
  assert.equal(state().status, 'failed');
  assert.match(state().error, /Jira rejected the query \(400\)/);
  assert.match(state().error, /does not exist for the field/);
  assert.equal((await status()).report, null);
});

test('a short page of group members does not end the listing', async () => {
  for (const id of ['u-5', 'u-6', 'u-7']) site.addUser(id, ['g-jsw']);
  const real = site.handle;
  // Jira hands back one member where fifty were asked for, and says there are more.
  site.handle = (method, p, body, as) => {
    const url = new URL(p, 'https://acme.atlassian.net');
    if (url.pathname === '/rest/api/3/group/member' && url.searchParams.get('groupId') === 'g-jsw' && url.searchParams.get('startAt') === '0') {
      return { body: { values: [site.users[site.groups['g-jsw'].members[0]]], isLast: false } };
    }
    return real(method, p, body, as);
  };
  await call(server, 'startScan', { days: 90 });
  await drain(server);
  assert.equal((await status()).report.totalUsers, 7);
});

test('a cancel wins over a slice in flight, and its scratch data is removed', async () => {
  await call(server, 'startScan', { days: 90 });
  await server.worker.handler(globalThis.__queue.shift()); // roles
  const run = state().run;
  const slice = server.worker.handler(globalThis.__queue.shift()); // members, in flight
  await call(server, 'cancelScan');
  await slice;
  assert.equal(state().status, 'cancelled');
  assert.equal(globalThis.__queue.length, 0);
  assert.deepEqual([...globalThis.__kvs.keys()].filter((k) => k.startsWith(`scan:${run}:`)), []);
});

test('a rate limit in the middle of a slice keeps what was collected and asks for a retry', async () => {
  await call(server, 'startScan', { days: 90 });
  while (state().phase !== 'verify') await server.worker.handler(globalThis.__queue.shift());
  site.once['GET /rest/api/3/user/groups'] = [{ status: 429, headers: { 'Retry-After': '9' }, body: {} }];
  const event = globalThis.__queue.shift();
  const res = await server.worker.handler(event);
  assert.equal(res.options.retryAfter, 9);
  assert.equal(state().status, 'running');
  await server.worker.handler(event); // the platform's retry of the same event
  await drain(server);
  assert.deepEqual(await listed(), ['u-idle', 'u-two']);
});
