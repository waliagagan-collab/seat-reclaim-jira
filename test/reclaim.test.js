import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAdminGroup,
  buildGroupsMeta,
  planReclaim,
  reasonText,
  explainChange,
  isIdpManaged,
  alreadyMember,
} from '../src/lib/reclaim.js';

// The demo site, as read on 10 October 2026: real people get Jira Software,
// JSM and Customer Service through org-admins, and each product also has its
// own default group.
const ROLES = [
  { key: 'jira-software', name: 'Jira Software', groups: [{ groupId: 'g-org', name: 'org-admins' }, { groupId: 'g-jsw', name: 'jira-users-site' }] },
  { key: 'jira-servicedesk', name: 'Jira Service Management', groups: [{ groupId: 'g-org', name: 'org-admins' }, { groupId: 'g-jsm', name: 'jira-servicemanagement-users-site' }] },
  { key: 'jira-product-discovery', name: 'Jira Product Discovery', groups: [{ groupId: 'g-jpd', name: 'jira-product-discovery-users-site' }] },
];
const META = buildGroupsMeta(ROLES);

test('admin groups are recognised however they are named', () => {
  for (const n of ['site-admins', 'org-admins', 'administrators', 'jira-admins-acme', 'Jira-Administrators']) {
    assert.equal(isAdminGroup(n), true, n);
  }
  for (const n of ['jira-users-acme', 'jira-servicemanagement-users-acme', 'confluence-users', '']) {
    assert.equal(isAdminGroup(n), false, n);
  }
});

test('a group that grants several products lists all of them', () => {
  assert.deepEqual(META['g-org'].products, ['Jira Software', 'Jira Service Management']);
  assert.deepEqual(META['g-jpd'].products, ['Jira Product Discovery']);
});

test('a plain user leaves every product group and frees every seat', () => {
  const plan = planReclaim({ userGroupIds: ['g-jsw', 'g-jsm', 'g-jpd', 'some-team-group'], groupsMeta: META });
  assert.equal(plan.reclaimable, true);
  assert.deepEqual(plan.remove.map((g) => g.groupId).sort(), ['g-jpd', 'g-jsm', 'g-jsw']);
  assert.deepEqual(plan.freedProducts, ['Jira Product Discovery', 'Jira Service Management', 'Jira Software']);
  assert.deepEqual(plan.keptProducts, []);
});

test('groups that grant no product are never touched', () => {
  const plan = planReclaim({ userGroupIds: ['g-jsw', 'some-team-group'], groupsMeta: META });
  assert.ok(!plan.remove.some((g) => g.groupId === 'some-team-group'));
});

test('an admin is never removed from an admin group, and keeps those products', () => {
  const plan = planReclaim({ userGroupIds: ['g-org', 'g-jsw', 'g-jpd'], groupsMeta: META });
  assert.equal(plan.reclaimable, true); // Product Discovery can still be freed
  assert.deepEqual(plan.remove.map((g) => g.groupId), ['g-jpd']);
  assert.deepEqual(plan.freedProducts, ['Jira Product Discovery']);
  assert.deepEqual(plan.keptProducts.map((k) => k.product), ['Jira Service Management', 'Jira Software']);
  // jira-users-site is NOT removed: leaving it frees nothing while org-admins grants Jira Software.
  assert.ok(!plan.remove.some((g) => g.groupId === 'g-jsw'));
});

test('someone whose only access is an admin group cannot be reclaimed, and the reason says why', () => {
  const plan = planReclaim({ userGroupIds: ['g-org'], groupsMeta: META });
  assert.equal(plan.reclaimable, false);
  assert.equal(plan.reason, 'admin');
  assert.match(reasonText(plan), /org-admins/);
  assert.match(reasonText(plan), /admin role/);
});

test('the person running the app and protected accounts are never reclaimable', () => {
  const self = planReclaim({ userGroupIds: ['g-jsw'], groupsMeta: META, protectedReason: 'self' });
  const prot = planReclaim({ userGroupIds: ['g-jsw'], groupsMeta: META, protectedReason: 'protected' });
  assert.equal(self.reclaimable, false);
  assert.equal(prot.reclaimable, false);
  assert.deepEqual(self.remove, []);
  assert.match(reasonText(self), /This is you/);
  assert.match(reasonText(prot), /protected/);
});

test('a user already outside every access group is reported, not acted on', () => {
  const plan = planReclaim({ userGroupIds: ['some-team-group'], groupsMeta: META });
  assert.equal(plan.reclaimable, false);
  assert.equal(plan.reason, 'no-access-groups');
});

test('duplicate group ids do not cause duplicate removals', () => {
  const plan = planReclaim({ userGroupIds: ['g-jsw', 'g-jsw'], groupsMeta: META });
  assert.equal(plan.remove.length, 1);
});

test('planning survives missing inputs', () => {
  const plan = planReclaim({ userGroupIds: undefined, groupsMeta: undefined });
  assert.equal(plan.reclaimable, false);
  assert.deepEqual(buildGroupsMeta(undefined), {});
});

test('with no group map at all (directory fallback) the reason is missing data, not a free seat', () => {
  const plan = planReclaim({ userGroupIds: ['g-jsw'], groupsMeta: {} });
  assert.equal(plan.reclaimable, false);
  assert.equal(plan.reason, 'no-role-data');
  assert.match(reasonText(plan), /licence groups/);
  assert.ok(!/already be free/.test(reasonText(plan)));
  assert.match(reasonText({ reclaimable: false, reason: 'active-since-scan' }), /active in Jira since the scan/);
});

test('a 403 on reclaim tells the admin that site admin is required', () => {
  assert.match(explainChange(403, null), /site admins/);
  assert.match(explainChange(404, { errorMessages: ['Group not found'] }), /Group not found/);
});

test('a group synced from an identity provider gets a plain explanation', () => {
  const scim = {
    errorMessages: [
      'An error occurred: com.atlassian.idp.client.exceptions.BadRequestException: {"status":"400","detail":"Group not modifiable","message":"Group not modifiable"}',
    ],
  };
  assert.equal(isIdpManaged(400, scim), true);
  assert.match(explainChange(400, scim), /identity provider/);
  assert.equal(isIdpManaged(400, { message: 'Group not modifiable' }), true);
  assert.equal(isIdpManaged(400, { errorMessages: ['User is already a member of the group'] }), false);
  assert.equal(isIdpManaged(403, scim), false);
  assert.match(explainChange(400, { errorMessages: ['Something else'] }), /Jira returned 400/);
});

test('undo treats "already a member" as restored', () => {
  assert.equal(alreadyMember(400, { errorMessages: ['Cannot add user. User is already a member of jira-users'] }), true);
  assert.equal(alreadyMember(400, { errorMessages: ['Something else'] }), false);
  assert.equal(alreadyMember(500, null), false);
});
