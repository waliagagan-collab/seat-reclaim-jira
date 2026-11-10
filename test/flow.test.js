import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeSite } from './fakes/jira-site.js';
import { loadServer, reset, drain, call, stored, ADMIN } from './helpers.js';

/**
 * The write path on a fake site: scan through the queue, reclaim, look at
 * History, undo. Storage and the queue are in memory (test/fakes).
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
  site.addUser('u-idle', ['g-jsw', 'g-team']); // never active
  site.addUser('u-busy', ['g-jsw']);
  site.lastActive['u-busy'] = 3;
  site.addUser('u-two', ['g-jsw', 'g-jsm']); // never active, two products
  reset(site);
});

async function scan() {
  const started = await call(server, 'startScan', { days: 90 });
  assert.equal(started.ok, true);
  await drain(server);
  const status = await call(server, 'getStatus');
  assert.equal(status.state.status, 'complete', status.state.error);
  return status.report;
}

const rowsById = async () => Object.fromEntries((await call(server, 'getAllRows')).rows.map((r) => [r.accountId, r]));
const entries = async () => (await call(server, 'getHistory', { page: 0 })).entries;

test('a scan lists the inactive users and keeps who is on the list', async () => {
  const report = await scan();
  assert.equal(report.totalUsers, 4);
  assert.equal(report.dormantCount, 2);
  assert.ok(report.startedAt, 'the scan start is kept with the report');
  const rows = await rowsById();
  assert.deepEqual(Object.keys(rows).sort(), ['u-idle', 'u-two']);
  assert.equal(rows['u-idle'].reclaimable, true);
  assert.deepEqual(rows['u-two'].freedProducts, ['Jira Service Management', 'Jira Software']);
  const listed = [...Array(16).keys()].flatMap((s) => stored(`report:ids:${s}`) ?? []);
  assert.deepEqual(listed.sort(), ['u-idle', 'u-two']);
});

test('the History entry is stored as pending before the first group is left, then updated', async () => {
  await scan();
  const res = await call(server, 'reclaim', { accountIds: ['u-two'] });
  assert.equal(res.ok, true);
  assert.equal(res.results[0].ok, true);
  assert.deepEqual(res.results[0].freedProducts, ['Jira Service Management', 'Jira Software']);
  assert.equal(site.removed.length, 2);
  for (const change of site.removed) {
    assert.equal(change.as, 'user', 'group changes run as the signed-in admin');
    assert.deepEqual(change.storedBefore, [{ accountId: 'u-two', status: 'pending' }]);
  }
  const [entry] = await entries();
  assert.equal(entry.status, 'reclaimed');
  assert.equal(entry.by, ADMIN);
  assert.deepEqual(entry.groups.map((g) => g.ok), [true, true]);
  assert.equal((await rowsById())['u-two'].lastAction.status, 'reclaimed');
});

test('undo puts the person back in exactly the groups that were left, and can be repeated', async () => {
  await scan();
  await call(server, 'reclaim', { accountIds: ['u-two'] });
  const [entry] = await entries();
  const undone = await call(server, 'undo', { entryId: entry.id });
  assert.equal(undone.ok, true);
  assert.deepEqual(site.added.map((a) => a.groupId).sort(), ['g-jsm', 'g-jsw']);
  assert.ok(site.groups['g-jsw'].members.includes('u-two'));
  assert.equal((await entries())[0].status, 'restored');
  assert.deepEqual(await call(server, 'undo', { entryId: entry.id }), { ok: true, already: true });
  assert.equal((await call(server, 'undo', { entryId: 'nope' })).ok, false);
});

test('an account that is not on the current list is never reclaimed', async () => {
  await scan();
  // u-busy holds a seat and is a real account, but the scan did not list it.
  const res = await call(server, 'reclaim', { accountIds: ['u-busy', 'made-up'] });
  assert.equal(res.ok, true);
  for (const r of res.results) {
    assert.equal(r.skipped, true);
    assert.match(r.error, /Not on the current list\. Run a new scan\./);
  }
  assert.equal(site.removed.length, 0);
  assert.deepEqual(await entries(), []);
});

test('reclaim is refused when there is no list at all', async () => {
  const res = await call(server, 'reclaim', { accountIds: ['u-idle'] });
  assert.equal(res.ok, false);
  assert.match(res.error, /Run a scan first/);
  assert.equal(site.removed.length, 0);
});

test('a report stored by the earlier version (no ID keys) still allows a reclaim of its rows only', async () => {
  await scan();
  const meta = stored('report:meta');
  delete meta.idShards;
  delete meta.startedAt;
  globalThis.__kvs.set('report:meta', meta);
  for (let s = 0; s < 16; s++) globalThis.__kvs.delete(`report:ids:${s}`);
  const res = await call(server, 'reclaim', { accountIds: ['u-idle', 'u-busy'] });
  assert.equal(res.results.find((r) => r.accountId === 'u-idle').ok, true);
  assert.match(res.results.find((r) => r.accountId === 'u-busy').error, /Not on the current list/);
});

test('a Jira administrator is never reclaimed: Jira is asked per person', async () => {
  await scan();
  // An admin whose admin right comes from a group that grants no product and
  // has no telling name, so only Jira's own answer finds it.
  site.admins.add('u-idle');
  const res = await call(server, 'reclaim', { accountIds: ['u-idle'] });
  assert.equal(res.results[0].skipped, true);
  assert.equal(res.results[0].error, 'Jira administrator: not reclaimed.');
  assert.equal(site.removed.length, 0);
  assert.deepEqual(await entries(), []);
  const check = globalThis.__calls.find((c) => c.path.startsWith('/rest/api/3/permissions/check'));
  assert.deepEqual(check.body, { accountId: 'u-idle', globalPermissions: ['ADMINISTER'] });
  assert.equal(check.as, 'user');
  // The row says so afterwards and is no longer offered.
  const row = (await rowsById())['u-idle'];
  assert.equal(row.lastAction.status, 'blocked');
  assert.equal(row.lastAction.reason, 'Jira administrator: not reclaimed.');
});

test('when Jira cannot confirm the person is not an administrator, nothing is changed', async () => {
  await scan();
  for (const answer of [{ status: 404, body: {} }, { status: 500, body: {} }, { body: { nothing: true } }, { throws: true }]) {
    site.once['POST /rest/api/3/permissions/check'] = [answer];
    const res = await call(server, 'reclaim', { accountIds: ['u-idle'] });
    assert.equal(res.results[0].skipped, true, JSON.stringify(answer));
    assert.match(res.results[0].error, /Could not confirm/);
  }
  assert.equal(site.removed.length, 0);
});

test('anyone in a group with "admin" in its name is left alone, whatever the group grants', async () => {
  // Three spellings the earlier whole-word rule missed, in groups that grant nothing.
  site.groups['g-a1'] = { name: 'JiraAdmins', members: [] };
  site.groups['g-a2'] = { name: 'Administratoren', members: [] };
  site.addUser('u-adm1', ['g-jsw', 'g-a1']);
  site.addUser('u-adm2', ['g-jsw', 'g-a2']);
  await scan();
  const rows = await rowsById();
  // At scan time the row already says so.
  assert.equal(rows['u-adm1'].reclaimable, false);
  assert.match(rows['u-adm1'].reason, /In an admin group \(JiraAdmins\)/);
  assert.equal(rows['u-adm2'].reclaimable, false);
  // And the reclaim step checks again, live, even if the page sends the ID.
  const res = await call(server, 'reclaim', { accountIds: ['u-adm1', 'u-adm2'] });
  for (const r of res.results) assert.match(r.error, /In an admin group/);
  assert.equal(site.removed.length, 0);
});

test('someone added to an admin group after the scan is caught at reclaim time', async () => {
  await scan();
  site.groups['g-late'] = { name: 'site-admins', members: ['u-idle'] };
  const res = await call(server, 'reclaim', { accountIds: ['u-idle'] });
  assert.match(res.results[0].error, /In an admin group \(site-admins\)/);
  assert.equal(site.removed.length, 0);
});

test('the person running the reclaim and protected people are refused by the server', async () => {
  site.lastActive[ADMIN] = 400; // inactive, and on the list
  await scan();
  await call(server, 'setProtected', { accountId: 'u-idle', protected: true });
  const res = await call(server, 'reclaim', { accountIds: [ADMIN, 'u-idle'] });
  assert.match(res.results[0].error, /This is you/);
  assert.match(res.results[1].error, /protected list/);
  assert.equal(site.removed.length, 0);
});

test('someone active since the scan is skipped', async () => {
  await scan();
  site.lastActive['u-idle'] = 0;
  const res = await call(server, 'reclaim', { accountIds: ['u-idle'] });
  assert.match(res.results[0].error, /active in Jira since the scan/);
  assert.equal(site.removed.length, 0);
});

test('the batch is capped on the server', async () => {
  for (const id of ['u-3', 'u-4', 'u-5']) site.addUser(id, ['g-jsw']);
  await scan();
  const res = await call(server, 'reclaim', { accountIds: ['u-idle', 'u-two', 'u-3', 'u-4', 'u-5'] });
  assert.equal(res.results.length, 3);
});

test('a partial reclaim does not count a product still held through the group that refused', async () => {
  site.groups['g-idp'] = { name: 'okta-jira', members: [] };
  site.roles[0].groups.push('g-idp');
  site.addUser('u-both', ['g-jsw', 'g-idp']);
  await scan();
  const idpRefusal = { status: 400, body: { errorMessages: ['{"status":"400","detail":"Group not modifiable"}'] } };
  // The first removal works, the second (the identity-provider group) is refused.
  const real = site.handle;
  site.handle = (method, p, body, as) => (method === 'DELETE' && p.includes('g-idp') ? idpRefusal : real(method, p, body, as));
  const res = await call(server, 'reclaim', { accountIds: ['u-both'] });
  assert.equal(res.results[0].partial, true);
  assert.deepEqual(res.results[0].freedProducts, []);
  const [entry] = await entries();
  assert.equal(entry.status, 'partial');
  assert.deepEqual(entry.freedProducts, []);
});

test('a reclaim that changes nothing leaves no History entry; the row carries the reason', async () => {
  site.groups['g-idp'] = { name: 'okta-jira', members: [] };
  site.roles[0].groups = ['g-idp'];
  site.addUser('u-idp', ['g-idp']);
  await scan();
  const real = site.handle;
  site.handle = (method, p, body, as) =>
    method === 'DELETE' ? { status: 400, body: { errorMessages: ['Group not modifiable'] } } : real(method, p, body, as);
  const res = await call(server, 'reclaim', { accountIds: ['u-idp'] });
  assert.equal(res.results[0].ok, false);
  assert.match(res.results[0].error, /identity provider/);
  assert.deepEqual(await entries(), []);
  assert.equal((await call(server, 'getHistory', { page: 0 })).total, 0);
  const row = (await rowsById())['u-idp'];
  assert.equal(row.lastAction.status, 'blocked');
  assert.match(row.lastAction.reason, /identity provider/);
});

test('a refusal for another reason is shown on the row and can be tried again', async () => {
  await scan();
  site.once['DELETE /rest/api/3/group/user'] = [{ status: 403, body: { errorMessages: ['You are not a site admin'] } }];
  const res = await call(server, 'reclaim', { accountIds: ['u-idle'] });
  assert.match(res.results[0].error, /Only site admins/);
  const row = (await rowsById())['u-idle'];
  assert.equal(row.lastAction.status, 'failed');
  assert.match(row.lastAction.reason, /site admins/);
  assert.deepEqual(await entries(), []);
  // Tried again as a site admin, it goes through.
  const again = await call(server, 'reclaim', { accountIds: ['u-idle'] });
  assert.equal(again.results[0].ok, true);
  assert.equal((await rowsById())['u-idle'].lastAction.status, 'reclaimed');
});

test('no answer from Jira is recorded as unknown, kept in History, and Undo re-adds the group', async () => {
  await scan();
  site.once['DELETE /rest/api/3/group/user'] = [{ throws: true }];
  const res = await call(server, 'reclaim', { accountIds: ['u-idle'] });
  assert.equal(res.results[0].ok, false);
  const [entry] = await entries();
  assert.equal(entry.status, 'partial');
  assert.equal(entry.groups[0].unknown, true);
  assert.equal((await call(server, 'undo', { entryId: entry.id })).ok, true);
});

test('when Jira asks for a pause, nothing is changed and the people are handed back to be sent again', async () => {
  await scan();
  site.once['GET /rest/api/3/user/groups'] = [{ status: 429, headers: { 'Retry-After': '7' }, body: {} }];
  const res = await call(server, 'reclaim', { accountIds: ['u-idle', 'u-two'] });
  assert.equal(res.ok, true);
  assert.equal(res.retryAfter, 7);
  assert.deepEqual(res.results.map((r) => r.retry), [true, true]);
  assert.equal(site.removed.length, 0);
  // A pause on the group change itself: the same, and no History entry.
  site.once['DELETE /rest/api/3/group/user'] = [{ status: 429, headers: { 'Retry-After': '3' }, body: {} }];
  const second = await call(server, 'reclaim', { accountIds: ['u-idle'] });
  assert.equal(second.retryAfter, 3);
  assert.equal(second.results[0].retry, true);
  assert.deepEqual(await entries(), []);
});

test('a failed name lookup at the end does not throw the results away', async () => {
  await scan();
  site.once['GET /rest/api/3/user/bulk'] = [{ status: 429, body: {} }];
  const res = await call(server, 'reclaim', { accountIds: ['u-idle'] });
  assert.equal(res.ok, true);
  assert.equal(res.results[0].ok, true);
  assert.equal(res.results[0].displayName, null);
});

test('a second call for the same person within a minute of a pending entry is refused', async () => {
  await scan();
  const at = new Date().toISOString();
  await server.store.saveEntry({ id: `${Date.now()}-aaaaaa`, type: 'reclaim', accountId: 'u-idle', at, updatedAt: at, status: 'pending', groups: [] });
  const res = await call(server, 'reclaim', { accountIds: ['u-idle'] });
  assert.match(res.results[0].error, /less than a minute ago/);
  assert.equal(site.removed.length, 0);
});

test('"Reclaimed" does not stick to someone a newer scan lists again', async () => {
  await scan();
  await call(server, 'reclaim', { accountIds: ['u-idle'] });
  assert.equal((await rowsById())['u-idle'].lastAction.status, 'reclaimed');
  // A colleague adds the person back outside the app; a later scan lists them.
  site.groups['g-jsw'].members.push('u-idle');
  await new Promise((r) => setTimeout(r, 5));
  await scan();
  const row = (await rowsById())['u-idle'];
  assert.equal(row.lastAction, null);
  assert.equal(row.reclaimable, true);
  assert.equal((await call(server, 'reclaim', { accountIds: ['u-idle'] })).results[0].ok, true);
});
