# Seat Reclaim for Jira

Finds licensed Jira users who have done nothing in a chosen period, then frees their
seats safely: the admin reviews the list, confirms, and the app takes each person out of
the groups that give them a product. Every change is logged and can be undone.

It reuses the activity engine from License Audit for Jira (same rules for what counts as
activity, same exhaustive per-user check). See `src/lib/jira.js`.

## What counts as activity

A sweep over recently updated issues proves most people active. Everyone it does not prove
active gets a per-user JQL query, and only that query can put someone on the list. The
query asks for `issue in updatedBy("<accountId>", "-<N>d")` (issues the person created,
any field they changed, comments they added, deleted or edited), plus the six
`CHANGED BY` fields, work logs and issues created. The same query runs for the 180- and
365-day bands and again, live, just before a reclaim. Being assigned an issue is not
activity. Being named as reporter is not activity unless the same person created the issue.

The sweep cannot be relied on by itself: Jira's search returns only the newest part of an
issue's comments and history. That is why nobody is listed on the sweep's word.

If Jira rejects the per-user query (400) it is asked once more without the work log
clause. If it is rejected again the person is "not checked": counted, named in a warning,
left off the list, and so never reclaimed. The query is tried first for the person who
started the scan; if Jira rejects it for them the scan stops with Jira's message.

## How a seat is reclaimed

A Jira Cloud seat comes from membership of a product's access group. Removing a user from
every group that grants a product frees that seat at once (proved on the demo site on
10 October 2026: Product Discovery 34,999 → 34,998 → 34,999 seats left).

| Rule | Where |
| --- | --- |
| Never reclaim a Jira administrator: Jira is asked about each person just before the change (`POST /rest/api/3/permissions/check`, `ADMINISTER`, as the signed-in admin). No clear "no" means no change | `hasAdminister`, `reclaim` resolver |
| Never reclaim anyone in a group with "admin" in its name (`/admin/i`), whatever that group grants. Checked on every group the person is in, at scan time for the row and again live at reclaim time | `isAdminGroup`, `planReclaim`, `readAdminGroups` |
| Never act on the person running the app, or on the protected list | `protectedReasonFor` |
| Act only on accounts on the current list | `getReportedIds`, `reclaim` resolver |
| Re-check activity and re-read the user's groups live before acting; the scan is a snapshot | `reclaim` resolver |
| Only leave groups that grant a product | `planReclaim` |
| Write the History entry before the first group is left; keep every entry, with no limit | `saveEntry`, `addToIndex` |
| Log exactly which groups were left; undo rejoins exactly those | `saveEntry`, `undo` |
| Group changes run as the signed-in admin (`asUser`), never as the app | `src/lib/reclaim.js` |

The name rule is wide on purpose. It also matches `badminton-club`. For an app that removes
access, a wrong "can't reclaim" is the safe mistake.

Leaving a group also removes anything else that group grants (another product, project
permissions). The confirm dialog says so.

A reclaim that changes nothing (every group refused) leaves no History entry. The reason is
kept on the person's row instead. A group managed by an identity provider refuses every
time, so that row is marked "Can't reclaim".

Jira requires a **site admin** for group membership changes. A Jira admin who is not a
site admin can scan and review, and gets a clear message if they try to reclaim.

## Permissions

Read scopes as License Audit, plus one write scope, `write:group:jira`, used only
for `DELETE` and `POST /rest/api/3/group/user`. A test enforces that this is the only write
scope and that no other module makes write calls. The administrator check
(`POST /rest/api/3/permissions/check`) only reads; it runs under the scopes the app has.

## Storage

Account IDs, group IDs and group names, product names and inactivity bands. People's names
and emails are never stored; they are looked up at read time. A History entry holds the
account IDs of the person and the approving admin, the groups left (ID and name), the
products they grant and, when Jira refused a group change, Jira's error text. A report row
for someone in an admin group holds that group's name. The protected list holds account IDs.

History keeps every entry. The newest 500 IDs are in `log:index`; older ones move, 250 at a
time, to `log:index:<n>` pages. Entries written by earlier versions are read as they are.

## Large sites

The scan runs in slices on the Forge queue. Each slice works for up to 240 seconds (the
function is allowed 300) and then queues the next. Forge stops a chain after 1,000 queued
events. If a push is refused, for that or any other reason, the scan is marked paused with
its cursor saved, and the page's status poll queues the next slice. A paused scan continues
while the page is open.

## Commands

```bash
npm test                 # unit tests
npm run deploy           # build the CSV frame and deploy to development
forge install --site one-atlas-afgn.atlassian.net --product jira --environment development
```
