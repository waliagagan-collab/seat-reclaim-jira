import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAdminGroup,
  adminGroupNames,
  buildGroupsMeta,
  planReclaim,
  reasonText,
  explainChange,
  isIdpManaged,
  alreadyMember,
  freedProductsFrom,
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
  for (const n of ['site-admins', 'org-admins', 'administrators', 'jira-admins-acme', 'Jira-Administrators', 'sysadmins', 'admin']) {
    assert.equal(isAdminGroup(n), true, n);
  }
  // Names the whole-word rule missed: no separator, or another language.
  for (const n of ['JiraAdmins', 'ITAdmins', 'siteadmins', 'superadmins', 'Administratoren', 'Administrateurs', 'jira-administration']) {
    assert.equal(isAdminGroup(n), true, n);
  }
  for (const n of ['jira-users-acme', 'jira-servicemanagement-users-acme', 'confluence-users', '']) {
    assert.equal(isAdminGroup(n), false, n);
  }
  // The rule is wide on purpose: for an app that removes access, a wrong
  // "can't reclaim" is the safe mistake.
  for (const n of ['badminton-club', 'administrative-assistants']) {
    assert.equal(isAdminGroup(n), true, n);
  }
  assert.deepEqual(adminGroupNames(['team-blue', 'JiraAdmins', undefined, 'JiraAdmins', 'site-admins']), ['JiraAdmins', 'site-admins']);
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

test('an administrator is not reclaimed at all, not even for a product the admin group does not grant', () => {
  // org-admins grants Jira Software and JSM; the person also holds Product
  // Discovery through its own group. Nothing is planned: no group is left.
  const plan = planReclaim({ userGroupIds: ['g-org', 'g-jsw', 'g-jpd'], groupsMeta: META });
  assert.equal(plan.reclaimable, false);
  assert.equal(plan.reason, 'admin');
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.freedProducts, []);
  assert.deepEqual(plan.adminGroups, ['org-admins']);
});

test('an admin group that grants no product still stops a reclaim', () => {
  // The caller passes the admin-like names among ALL the person's groups.
  const plan = planReclaim({ userGroupIds: ['g-jsw', 'g-jpd'], groupsMeta: META, adminGroups: ['jira-admins-site'] });
  assert.equal(plan.reclaimable, false);
  assert.equal(plan.reason, 'admin');
  assert.deepEqual(plan.remove, []);
  assert.match(reasonText(plan), /jira-admins-site/);
  // Without such a group the same person is an ordinary user.
  assert.equal(planReclaim({ userGroupIds: ['g-jsw', 'g-jpd'], groupsMeta: META, adminGroups: [] }).reclaimable, true);
});

test('someone whose only access is an admin group cannot be reclaimed, and the reason says why', () => {
  const plan = planReclaim({ userGroupIds: ['g-org'], groupsMeta: META });
  assert.equal(plan.reclaimable, false);
  assert.equal(plan.reason, 'admin');
  assert.match(reasonText(plan), /org-admins/);
  assert.match(reasonText(plan), /never reclaims anyone in a group with "admin" in its name/);
  // A row planned by the earlier version named the group under keptProducts.
  assert.match(reasonText({ reclaimable: false, reason: 'admin', keptProducts: [{ product: 'Jira Software', via: 'site-admins' }] }), /site-admins/);
});

test('the reasons a reclaim is skipped are plain', () => {
  assert.equal(reasonText({ reclaimable: false, reason: 'jira-admin' }), 'Jira administrator: not reclaimed.');
  assert.match(reasonText({ reclaimable: false, reason: 'admin-unconfirmed' }), /Could not confirm/);
  assert.equal(reasonText({ reclaimable: false, reason: 'not-on-list' }), 'Not on the current list. Run a new scan.');
  assert.match(reasonText({ reclaimable: false, reason: 'in-flight' }), /less than a minute ago/);
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
  assert.match(reasonText(plan), /could not read which groups give each Jira product/);
  // A reinstall starts with an empty History (no Undo), so the advice is to update.
  assert.match(reasonText(plan), /update Seat Reclaim/);
  assert.doesNotMatch(reasonText(plan), /reinstall/i);
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
  // The same refusal as a 403 is read the same way, as in the Confluence app.
  assert.equal(isIdpManaged(403, scim), true);
  assert.equal(isIdpManaged(403, { message: 'This group is managed by an external identity provider' }), true);
  assert.equal(isIdpManaged(403, { errorMessages: ['You are not a site admin'] }), false);
  assert.equal(isIdpManaged(500, scim), false);
  assert.match(explainChange(400, { errorMessages: ['Something else'] }), /Jira returned 400/);
});

test('a refusal shows whatever reason Jira gave, wherever it put it', () => {
  assert.match(explainChange(400, { message: 'Group is archived' }), /Jira returned 400\. \(Group is archived\)/);
  assert.match(explainChange(400, { errors: { groupId: 'No such group' } }), /No such group/);
  assert.match(explainChange(403, { message: 'Site admin only' }), /Only site admins.*Site admin only/);
  assert.match(explainChange(429, null), /slow down/);
});

test('undo treats "already a member" as restored', () => {
  assert.equal(alreadyMember(400, { errorMessages: ['Cannot add user. User is already a member of jira-users'] }), true);
  assert.equal(alreadyMember(400, { errorMessages: ['Something else'] }), false);
  assert.equal(alreadyMember(500, null), false);
});

test('only groups that were actually left count as freed products', () => {
  const changes = [
    { groupId: 'g1', name: 'jira-software-users', products: ['Jira Software'], ok: true },
    { groupId: 'g2', name: 'jira-servicemanagement-users', products: ['Jira Service Management'], ok: false, error: 'refused' },
  ];
  assert.deepEqual(freedProductsFrom(changes), ['Jira Software']);
  assert.deepEqual(freedProductsFrom(changes, [{ product: 'Jira Software', via: 'site-admins' }]), []);
  assert.deepEqual(freedProductsFrom(undefined), []);
});

test('a product still held through a group that was not left is not counted as freed', () => {
  const changes = [
    { groupId: 'g1', name: 'jira-software-users', products: ['Jira Software', 'Jira Product Discovery'], ok: true },
    { groupId: 'g2', name: 'okta-jira', products: ['Jira Software'], ok: false, error: 'refused' },
    { groupId: 'g3', name: 'jsm-agents', products: ['Jira Service Management'], ok: false, unknown: true },
  ];
  assert.deepEqual(freedProductsFrom(changes), ['Jira Product Discovery']);
});
