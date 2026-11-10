// A small fake Jira site for the scan and reclaim tests. It answers the
// endpoints the app calls. A test changes its fields to set up a case.

export function makeSite() {
  const site = {
    // Accounts that hold the Administer Jira permission.
    admins: new Set(['admin-1']),
    // Every group on the site: id -> { name, members }.
    groups: {
      'g-jsw': { name: 'jira-software-users-acme', members: [] },
      'g-jsm': { name: 'jira-servicemanagement-users-acme', members: [] },
      'g-team': { name: 'team-blue', members: [] },
    },
    // Which groups grant which product (application roles).
    roles: [
      { key: 'jira-software', name: 'Jira Software', groups: ['g-jsw'] },
      { key: 'jira-servicedesk', name: 'Jira Service Management', groups: ['g-jsm'] },
    ],
    users: {},
    // accountId -> days since the person last did anything (absent: never).
    lastActive: {},
    // Issues the activity sweep returns.
    sweep: [],
    // The per-user query answers 400 for these accounts, always.
    reject: new Set(),
    // ... or only while the query has the work log clause.
    rejectWorklog: new Set(),
    // The next answers for a call, by "<METHOD> <path start>": a list of
    // { status, body, headers } used once each, before the normal answer.
    once: {},
    memberPage: 50,
    // A promise the next call waits for before it is answered, so a test can
    // hold one copy of a slice while another copy runs.
    holdNext: null,
    // What happened, for assertions.
    removed: [],
    added: [],

    addUser(accountId, groupIds, extra = {}) {
      site.users[accountId] = { accountId, displayName: `Name ${accountId}`, active: true, accountType: 'atlassian', ...extra };
      for (const g of groupIds) site.groups[g].members.push(accountId);
    },
    groupsOf(accountId) {
      return Object.entries(site.groups)
        .filter(([, g]) => g.members.includes(accountId))
        .map(([groupId, g]) => ({ groupId, name: g.name }));
    },

    handle(method, rawPath, body, as) {
      if (site.holdNext) {
        const held = site.holdNext;
        site.holdNext = null;
        return held.then(() => site.handle(method, rawPath, body, as));
      }
      const url = new URL(rawPath, 'https://acme.atlassian.net');
      const p = url.pathname;
      const q = url.searchParams;
      for (const [start, list] of Object.entries(site.once)) {
        const [m, prefix] = start.split(' ');
        if (m === method && p.startsWith(prefix) && list.length) return list.shift();
      }

      if (p === '/rest/api/3/mypermissions') {
        return { body: { permissions: { ADMINISTER: { havePermission: true } } } };
      }
      if (p === '/rest/api/3/applicationrole') {
        return {
          body: site.roles.map((r) => ({
            key: r.key,
            name: r.name,
            defined: true,
            userCount: new Set(r.groups.flatMap((g) => site.groups[g].members)).size,
            groupDetails: r.groups.map((g) => ({ groupId: g, name: site.groups[g].name })),
          })),
        };
      }
      if (p === '/rest/api/3/group/member') {
        const members = site.groups[q.get('groupId')]?.members ?? [];
        const startAt = Number(q.get('startAt') ?? 0);
        const values = members.slice(startAt, startAt + site.memberPage).map((id) => site.users[id]);
        return { body: { values, isLast: startAt + values.length >= members.length } };
      }
      if (p === '/rest/api/3/search/jql') {
        const jql = q.get('jql') ?? '';
        const who = jql.match(/updatedBy\("([^"]+)", "-(\d+)d"\)/);
        if (!who) return { body: { issues: site.sweep, isLast: true } };
        const [, accountId, days] = who;
        if (site.reject.has(accountId) || (site.rejectWorklog.has(accountId) && /worklogAuthor/.test(jql))) {
          return { status: 400, body: { errorMessages: [`The value '${accountId}' does not exist for the field 'worklogAuthor'.`] } };
        }
        const last = site.lastActive[accountId];
        return { body: { issues: last !== undefined && last <= Number(days) ? [{ id: '1' }] : [] } };
      }
      if (p === '/rest/api/3/user/groups') {
        return { body: site.groupsOf(q.get('accountId')).map((g) => ({ ...g, self: 'x' })) };
      }
      if (p === '/rest/api/3/permissions/check' && method === 'POST') {
        if (!site.users[body.accountId] && !site.admins.has(body.accountId)) return { status: 404, body: { errorMessages: ['not found'] } };
        return { body: { globalPermissions: site.admins.has(body.accountId) ? ['ADMINISTER'] : [], projectPermissions: [] } };
      }
      if (p === '/rest/api/3/group/user' && method === 'DELETE') {
        const g = site.groups[q.get('groupId')];
        const accountId = q.get('accountId');
        // What storage held at the moment of the change, for the order test.
        site.removed.push({ groupId: q.get('groupId'), accountId, as, storedBefore: [...(globalThis.__kvs?.entries() ?? [])].filter(([k]) => k.startsWith('log:entry:')).map(([, v]) => ({ accountId: v.accountId, status: v.status })) });
        if (!g) return { status: 404, body: { errorMessages: ['Group not found'] } };
        g.members = g.members.filter((id) => id !== accountId);
        return { body: {} };
      }
      if (p === '/rest/api/3/group/user' && method === 'POST') {
        const g = site.groups[q.get('groupId')];
        if (!g) return { status: 404, body: { errorMessages: ['Group not found'] } };
        if (g.members.includes(body.accountId)) return { status: 400, body: { errorMessages: ['Cannot add user. User is already a member of the group'] } };
        g.members.push(body.accountId);
        site.added.push({ groupId: q.get('groupId'), accountId: body.accountId, as });
        return { status: 201, body: {} };
      }
      if (p === '/rest/api/3/user/bulk') {
        return { body: { values: q.getAll('accountId').map((id) => site.users[id] ?? (site.admins.has(id) ? { accountId: id, displayName: 'Admin' } : null)).filter(Boolean) } };
      }
      return { status: 404, body: { errorMessages: [`fake site: no answer for ${method} ${p}`] } };
    },
  };
  return site;
}
