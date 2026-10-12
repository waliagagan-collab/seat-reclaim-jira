import api, { route } from '@forge/api';

/**
 * Reclaiming a seat means taking the user out of every group that gives them
 * access to a product. Everything about WHICH groups, and what that frees,
 * is decided by the pure functions at the top of this file, so the rules can
 * be tested without a Jira site.
 *
 * Hard rules:
 *   - Never touch an admin group. Removing someone from site-admins or
 *     org-admins takes away their admin role, which is not this app's job,
 *     and Atlassian requires admins to lose that role before product access
 *     can be removed anyway.
 *   - Never touch the person running the app, or anyone on the protected list.
 *   - Always read the user's groups live before acting. The scan is a snapshot.
 *   - Record exactly which groups were left, so undo puts the user back in the
 *     same groups and nothing else.
 */

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

/** Groups the app will never remove anyone from. Deliberately broad. */
export const isAdminGroup = (name) => /admin/i.test(String(name ?? ''));

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
 * Returns:
 *   reclaimable    - true when at least one product seat would be freed
 *   reason         - why not, when not reclaimable
 *   remove         - access groups to leave: [{ groupId, name, products }]
 *   freedProducts  - products the user loses access to
 *   keptProducts   - products the user keeps, and the admin group that keeps them
 */
export function planReclaim({ userGroupIds, groupsMeta, protectedReason = null }) {
  if (protectedReason) {
    return { reclaimable: false, reason: protectedReason, remove: [], freedProducts: [], keptProducts: [] };
  }

  const remove = [];
  const keptVia = new Map(); // product -> admin group name that keeps it
  for (const id of new Set(userGroupIds ?? [])) {
    const g = groupsMeta?.[id];
    if (!g) continue; // not an access group, so leaving it frees nothing
    if (isAdminGroup(g.name)) {
      for (const p of g.products) if (!keptVia.has(p)) keptVia.set(p, g.name);
    } else {
      remove.push({ groupId: id, name: g.name, products: [...g.products] });
    }
  }

  const removedProducts = new Set(remove.flatMap((g) => g.products));
  const freedProducts = [...removedProducts].filter((p) => !keptVia.has(p)).sort();
  const keptProducts = [...keptVia.entries()]
    .map(([product, via]) => ({ product, via }))
    .sort((a, b) => a.product.localeCompare(b.product));

  if (freedProducts.length === 0) {
    return {
      reclaimable: false,
      reason: keptVia.size ? 'admin' : 'no-access-groups',
      remove: [],
      freedProducts: [],
      keptProducts,
    };
  }

  // Leaving a group that only grants kept products would change nothing, so
  // only the groups that actually free something are removed.
  const useful = remove.filter((g) => g.products.some((p) => freedProducts.includes(p)));
  return { reclaimable: true, reason: null, remove: useful, freedProducts, keptProducts };
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
      const via = [...new Set(plan.keptProducts.map((k) => k.via))].join(', ');
      return `Access comes from an admin group (${via}). Remove their admin role in Atlassian Administration first.`;
    }
    case 'no-access-groups':
      return 'Not in any product access group any more. Their seat may already be free.';
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
 * "Group not modifiable" (from the SCIM layer).
 */
export const isIdpManaged = (status, body) =>
  status === 400 && /not modifiable|identity provider|scim|externally managed|read[- ]?only/i.test(errorText(body));

/** Pure: words for a failed Jira call during reclaim or undo. */
export function explainChange(status, body) {
  if (isIdpManaged(status, body)) return IDP_MANAGED_MESSAGE;
  const detail = body?.errorMessages?.length ? ` (${body.errorMessages.join('; ')})` : '';
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

/** The user's groups right now, read as the admin. Throws with a clear message. */
export async function fetchUserGroupIds(accountId) {
  const res = await api
    .asUser()
    .requestJira(route`/rest/api/3/user/groups?accountId=${accountId}`, { headers: JSON_HEADERS });
  if (!res.ok) throw new Error(explainChange(res.status, await bodyOf(res)));
  const rows = (await res.json()) ?? [];
  return rows.map((g) => g?.groupId).filter(Boolean);
}

/** Remove one user from the planned groups. Returns per-group results. */
export async function removeFromGroups(accountId, groups) {
  const results = [];
  for (const g of groups) {
    const res = await api
      .asUser()
      .requestJira(route`/rest/api/3/group/user?groupId=${g.groupId}&accountId=${accountId}`, {
        method: 'DELETE',
        headers: JSON_HEADERS,
      });
    const ok = res.ok;
    results.push({
      groupId: g.groupId,
      name: g.name,
      products: g.products,
      ok,
      error: ok ? null : explainChange(res.status, await bodyOf(res)),
    });
  }
  return results;
}

/** Put one user back in the groups a reclaim removed. Returns per-group results. */
export async function addToGroups(accountId, groups) {
  const results = [];
  for (const g of groups) {
    const res = await api
      .asUser()
      .requestJira(route`/rest/api/3/group/user?groupId=${g.groupId}`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ accountId }),
      });
    const body = res.ok ? null : await bodyOf(res);
    const ok = res.ok || alreadyMember(res.status, body);
    results.push({ groupId: g.groupId, name: g.name, ok, error: ok ? null : explainChange(res.status, body) });
  }
  return results;
}
