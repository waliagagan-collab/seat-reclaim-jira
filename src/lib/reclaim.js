import api, { route } from '@forge/api';

/**
 * Reclaiming a seat means taking the user out of every group that gives them
 * access to a product. Everything about WHICH groups, and what that frees,
 * is decided by the pure functions at the top of this file, so the rules can
 * be tested without a Jira site.
 *
 * Hard rules:
 *   - Never reclaim an administrator. Two checks, per person, not per product:
 *     Jira is asked whether the person holds the Administer Jira permission
 *     (hasAdminister, at reclaim time, as the signed-in admin), and anyone in
 *     a group with "admin" in its name is left alone whatever that group
 *     grants (at scan time for the row's status, and again at reclaim time).
 *   - Never touch the person running the app, or anyone on the protected list.
 *   - Always read the user's groups live before acting. The scan is a snapshot.
 *   - Record exactly which groups were left, so undo puts the user back in the
 *     same groups and nothing else.
 */

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

/**
 * A group named like an admin group. Deliberately wide: site-admins,
 * JiraAdmins, Administratoren, and also badminton-club. For an app that
 * removes access, a wrong "can't reclaim" is the safe mistake. A member of
 * any such group is never reclaimed.
 */
export const isAdminGroup = (name) => /admin/i.test(String(name ?? ''));

/** Pure: the admin-like names in a list of group names, each once. */
export const adminGroupNames = (names) => [...new Set((names ?? []).filter((n) => n && isAdminGroup(n)))];

/**
 * Pure: role rows (normaliseRoles) -> { groupId -> { name, products[] } }.
 * One group can grant several products, so products is a list.
 */
export function buildGroupsMeta(roles) {
  const meta = {};
  for (const r of roles ?? []) {
    for (const g of r.groups ?? []) {
      const entry = meta[g.groupId] ?? { name: g.name, products: [] };
      if (!entry.products.includes(r.name)) entry.products.push(r.name);
      meta[g.groupId] = entry;
    }
  }
  return meta;
}

/**
 * Pure. Given the groups a user is in right now, decide what reclaiming does.
 *
 * `adminGroups` are the admin-like names among ALL the user's groups (see
 * adminGroupNames), not only the ones that grant a product. The names of the
 * access groups in `groupsMeta` are checked too, so a caller that has no
 * group names still gets the rule for the groups it knows.
 *
 * Returns:
 *   reclaimable    - true when at least one product seat would be freed
 *   reason         - why not, when not reclaimable
 *   remove         - access groups to leave: [{ groupId, name, products }]
 *   freedProducts  - products the user loses access to
 *   adminGroups    - the admin groups that stop a reclaim, when reason is 'admin'
 *   keptProducts   - always empty now: an administrator is not reclaimed at
 *                    all (kept so stored entries keep one shape)
 */
export function planReclaim({ userGroupIds, groupsMeta, protectedReason = null, adminGroups = [] }) {
  const none = { reclaimable: false, remove: [], freedProducts: [], keptProducts: [] };
  if (protectedReason) return { ...none, reason: protectedReason };
  // No group map at all means the scan fell back to the site directory: the
  // app has nothing to plan from, which is not the same as the user holding
  // no access group.
  if (!groupsMeta || Object.keys(groupsMeta).length === 0) return { ...none, reason: 'no-role-data' };

  const remove = [];
  const admin = [...(adminGroups ?? [])];
  for (const id of new Set(userGroupIds ?? [])) {
    const g = groupsMeta?.[id];
    if (!g) continue; // not an access group, so leaving it frees nothing
    if (isAdminGroup(g.name)) admin.push(g.name);
    else remove.push({ groupId: id, name: g.name, products: [...g.products] });
  }
  if (admin.length) return { ...none, reason: 'admin', adminGroups: adminGroupNames(admin) };

  const freedProducts = [...new Set(remove.flatMap((g) => g.products))].sort();
  if (freedProducts.length === 0) return { ...none, reason: 'no-access-groups' };
  return { reclaimable: true, reason: null, remove, freedProducts, keptProducts: [] };
}

/** Pure: why a row can't be reclaimed, in words an admin can act on. */
export function reasonText(plan) {
  if (!plan || plan.reclaimable) return null;
  switch (plan.reason) {
    case 'self':
      return 'This is you. The app never removes the person running it.';
    case 'protected':
      return 'On your protected list.';
    case 'admin': {
      // A row stored by an earlier version names the group under keptProducts.
      const via = (plan.adminGroups?.length ? plan.adminGroups : [...new Set((plan.keptProducts ?? []).map((k) => k.via))]).join(', ');
      return `In an admin group (${via}). The app never reclaims anyone in a group with "admin" in its name.`;
    }
    case 'jira-admin':
      return 'Jira administrator: not reclaimed.';
    case 'admin-unconfirmed':
      return "Could not confirm that this person is not a Jira administrator, so their seat was left alone. Try again.";
    case 'not-on-list':
      return 'Not on the current list. Run a new scan.';
    case 'in-flight':
      return 'A reclaim for this person started less than a minute ago. Check the History tab before trying again.';
    case 'no-access-groups':
      return 'Not in any product access group any more. Their seat may already be free.';
    case 'no-role-data':
      return "The app couldn't read Jira's licence groups during the scan, so it can't plan a reclaim. Reinstalling the app usually restores that permission; then run a new scan.";
    case 'active-since-scan':
      return 'Has been active in Jira since the scan, so their seat was left alone. Run a new scan for a current list.';
    default:
      return 'Cannot be reclaimed.';
  }
}

/** Pure: every message Jira put in an error body, as one string. */
const errorText = (body) =>
  [
    ...(body?.errorMessages ?? []),
    ...Object.values(body?.errors ?? {}),
    body?.message,
    body?.detail,
  ]
    .filter((m) => typeof m === 'string' && m)
    .join(' ');

export const IDP_MANAGED_MESSAGE =
  "This group is managed by your identity provider (for example Okta or Microsoft Entra ID), so Jira won't change it here. Remove the user from the group in your identity provider instead.";

/**
 * Pure: is this the refusal Jira gives for a group synced from an identity
 * provider? Those groups are read-only in Atlassian; Jira answers 400 with
 * "Group not modifiable" (from the SCIM layer). A 403 with the same words is
 * read the same way, as the Confluence app does.
 */
export const isIdpManaged = (status, body) =>
  (status === 400 || status === 403) &&
  /not modifiable|identity provider|scim|externally managed|read[- ]?only|managed by/i.test(errorText(body));

export const RATE_LIMITED_MESSAGE =
  'Jira asked the app to slow down (429). Nothing was changed for this group; try again in a minute.';

/** Pure: words for a failed Jira call during reclaim or undo. */
export function explainChange(status, body) {
  if (isIdpManaged(status, body)) return IDP_MANAGED_MESSAGE;
  if (status === 429) return RATE_LIMITED_MESSAGE;
  const text = errorText(body);
  const detail = text ? ` (${text})` : '';
  if (status === 403 || status === 401) {
    return `Jira refused (${status}). Only site admins can change group membership. Ask a site admin to run this.${detail}`;
  }
  if (status === 404) return `Group or user not found (404). It may have been deleted.${detail}`;
  return `Jira returned ${status}.${detail}`;
}

/**
 * Pure: a group-membership POST that says the user is already in the group
 * counts as restored. Jira answers that with a 400.
 */
export const alreadyMember = (status, body) =>
  status === 400 && /already a member/i.test((body?.errorMessages ?? []).join(' '));

/**
 * Pure: the products a set of group changes actually freed. Only groups that
 * were left count, and a product the user still holds through a group that
 * was NOT left (refused, or no answer) is not freed.
 */
export function freedProductsFrom(changes, keptProducts = []) {
  const kept = new Set((keptProducts ?? []).map((k) => k.product));
  for (const c of changes ?? []) if (!c.ok) for (const p of c.products ?? []) kept.add(p);
  const freed = new Set((changes ?? []).filter((c) => c.ok).flatMap((c) => c.products ?? []));
  return [...freed].filter((p) => !kept.has(p)).sort();
}

export const NO_REPLY_MESSAGE =
  "Jira did not answer. The change may or may not have gone through; check the person's groups in Atlassian Administration before trying again.";

// ---------------------------------------------------------------------------
// Side effects (all as the signed-in admin)
// ---------------------------------------------------------------------------

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };

async function bodyOf(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

const retryAfterOf = (res) => Math.max(1, Number(res.headers?.get?.('Retry-After')) || 5);

function rateLimited(res) {
  const err = new Error('Rate limited by Jira');
  err.rateLimited = true;
  err.retryAfter = retryAfterOf(res);
  return err;
}

/** The user's groups right now, read as the admin: [{ groupId, name }]. Throws with a clear message. */
export async function fetchUserGroups(accountId) {
  const res = await api
    .asUser()
    .requestJira(route`/rest/api/3/user/groups?accountId=${accountId}`, { headers: JSON_HEADERS });
  if (res.status === 429) throw rateLimited(res);
  if (!res.ok) throw new Error(explainChange(res.status, await bodyOf(res)));
  const rows = (await res.json()) ?? [];
  return rows.filter((g) => g?.groupId).map((g) => ({ groupId: g.groupId, name: g.name ?? g.groupId }));
}

/**
 * Does this person hold the Administer Jira permission? Asked of Jira as the
 * signed-in admin (Jira lets an admin check another user). true | false, or
 * null when Jira gave no clear answer; the caller must then leave the person
 * alone. A rate limit is thrown, so the caller can wait and try again.
 */
export async function hasAdminister(accountId) {
  let res;
  try {
    res = await api.asUser().requestJira(route`/rest/api/3/permissions/check`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ accountId, globalPermissions: ['ADMINISTER'] }),
    });
  } catch {
    return null;
  }
  if (res.status === 429) throw rateLimited(res);
  if (!res.ok) return null;
  const body = await bodyOf(res);
  if (!Array.isArray(body?.globalPermissions)) return null;
  return body.globalPermissions.includes('ADMINISTER');
}

/**
 * Remove one user from the planned groups. Returns per-group results. When
 * Jira asks for a pause (429) the remaining groups are not tried; each is
 * returned as not done, with `rateLimited` and the wait Jira asked for.
 */
export async function removeFromGroups(accountId, groups) {
  const results = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    let res;
    try {
      res = await api
        .asUser()
        .requestJira(route`/rest/api/3/group/user?groupId=${g.groupId}&accountId=${accountId}`, {
          method: 'DELETE',
          headers: JSON_HEADERS,
        });
    } catch {
      // No response at all. The removal may have happened, so it is recorded
      // as unknown: undo re-adds it, and the admin is told to check.
      results.push({ groupId: g.groupId, name: g.name, products: g.products, ok: false, unknown: true, error: NO_REPLY_MESSAGE });
      continue;
    }
    if (res.status === 429) {
      const retryAfter = retryAfterOf(res);
      for (const rest of groups.slice(i)) {
        results.push({ groupId: rest.groupId, name: rest.name, products: rest.products, ok: false, rateLimited: true, retryAfter, error: RATE_LIMITED_MESSAGE });
      }
      break;
    }
    const ok = res.ok;
    const body = ok ? null : await bodyOf(res);
    results.push({
      groupId: g.groupId,
      name: g.name,
      products: g.products,
      ok,
      error: ok ? null : explainChange(res.status, body),
      ...(!ok && isIdpManaged(res.status, body) ? { idpManaged: true } : {}),
    });
  }
  return results;
}

/** Put one user back in the groups a reclaim removed. Returns per-group results. */
export async function addToGroups(accountId, groups) {
  const results = [];
  for (const g of groups) {
    let res;
    try {
      res = await api
        .asUser()
        .requestJira(route`/rest/api/3/group/user?groupId=${g.groupId}`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ accountId }),
        });
    } catch {
      results.push({ groupId: g.groupId, name: g.name, ok: false, unknown: true, error: NO_REPLY_MESSAGE });
      continue;
    }
    const body = res.ok ? null : await bodyOf(res);
    const ok = res.ok || alreadyMember(res.status, body);
    results.push({ groupId: g.groupId, name: g.name, ok, error: ok ? null : explainChange(res.status, body) });
  }
  return results;
}
