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
| Write the History entry before the first group is left; keep every entry, with no limit (the weekly personal data report removes only entries about closed accounts) | `saveEntry`, `addToIndex` |
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
The one other scope, `report:personal-data` (added 14 November 2026), only sends Atlassian
the account IDs the app keeps (see "Personal data reporting" below).

## Storage

Account IDs, group IDs and group names, product names and inactivity bands. People's names
and emails are never stored; they are looked up at read time. A History entry holds the
account IDs of the person, the approving admin and the admin who undid it, the groups left
(ID and name), the products they grant and, when Jira refused a group change, Jira's error
text. A report row for someone in an admin group holds that group's name. The protected list
holds the account IDs of each protected person and of the admin who protected them. The
latest action on each person (or why the last try changed nothing, with Jira's text) is kept
by account ID, to mark their row. The account IDs are reported to Atlassian once a week, and
those of closed accounts are erased (see "Personal data reporting" below).

History keeps every entry, except an entry about a person whose Atlassian account was
closed. The newest 500 IDs are in `log:index`; older ones move, 250 at a time, to
`log:index:<n>` pages. `log:index:meta` counts the pages, and keeps each page's size once one
holds fewer than 250. Entries written by earlier versions are read as they are.

## Personal data reporting

Atlassian asks every app that keeps account IDs to report them, so it can say which
accounts were closed. This app does it with Forge's `privacy.reportPersonalData`, which
needs the scope `report:personal-data` (added 14 November 2026; it makes the next
production deploy a major version).

**When.** An hourly scheduled trigger (`personal-data-report`) runs one slice of the
report, at most 40 seconds, or nothing when this week's report is done. A new report
starts 7 days after the last report call of the one before, so no account is reported
more often than once in 7 days. It runs whatever the licence says. On most sites a
report is done in one run.

**What is reported.** Every account ID the app keeps, 90 per call:

| Stored value | Account IDs in it |
| --- | --- |
| `report:ids:{s}` and `report:dormant:{i}`, the last list | each inactive user |
| `scan:state`, the scan in progress or the last one | the admin who started it; any account ID quoted in a Jira error text it kept |
| `scan:{run}:users:{s}`, `:active:{s}`, `:dormant:{s}`, working data of a scan | every licensed user, those seen acting, the inactive rows so far |
| `protected`, the protected list | each protected person, and the admin who protected them |
| `log:entry:{id}`, a History entry | the person reclaimed, the admin who approved it and the admin who undid it; any account ID in Jira's error texts |
| `log:latest:{s}`, the latest action on each person | each person reclaimed or tried; any account ID in Jira's error text |

`report:meta` (totals, products, groups, fixed warnings), History's index (`log:index`,
`log:index:{n}`, `log:index:meta`: entry IDs and counts only), `action:started` (when a
reclaim or an undo last started) and `settings` (seat prices, the day the review request
was closed) hold no account ID. Names and emails are never stored, so an account whose
profile changed needs nothing.

**What is erased for a closed account.**

- Its row on the list and its place in `report:ids` are taken out, so it can no longer be
  reclaimed. Nothing is put in its place: the list is not signed evidence, and every scan
  builds it again.
- Every History entry about the person is deleted, after its ID is taken out of History's
  index and archive pages. Undo could only give a closed account its groups back. History
  still pages through every other entry, 25 at a time.
- Their protected-list entry and the latest-action note on their row are taken out.
- Where the closed account is the admin who approved or undid a reclaim, `by` or
  `restoredBy` in the entry becomes empty (null), and History and the Rovo agent show
  "Closed account". Where it started a scan or protected someone, `startedBy` or that
  protected entry's `by` becomes empty.
- In a Jira error text the account ID becomes "(closed account)".
- It is taken out of the working data of a scan.
- The totals already shown (licensed, active and inactive users, inactive seats and their
  cost per product) stay as the scan counted them. **The next scan counts again.** Until
  then the page, the download and the Rovo agent say how many users on the list are no
  longer listed because their accounts were closed.

**While the app is writing.** A scan writes the list and its working data; a reclaim or an
undo writes History from what it read a moment before. So erasing waits while a scan is
running and has moved in the last 20 minutes, and for a minute after a reclaim or an undo
starts (each is one resolver call, which Forge stops after 25 seconds; each notes when it
started in `action:started`). The report asks before each value it changes (`busy` in
`src/lib/personal-data.js`), and the value is read again just before it is written. A scan
that has not moved for 20 minutes (stopped, or paused with nobody on the page) does not
hold erasing back; if it goes on later it finds fewer users to count, and a scan whose
starter was erased skips the first check that runs for the starter.

The report's own working values (`pdr:state`, `pdr:lock`, and the gathered, closed and
changed IDs under `pdr:ids:`, `pdr:closed:` and `pdr:updated:`) are deleted when a report
ends, except the state with the totals of the last report. The log line of each run names
the step and, at the end, the totals; never an account ID.

`test/privacy.test.js` is the shared report engine's own test, copied with it.
`test/personal-data.test.js` lists every key the app writes and fails if one holds an
account ID no source reads; it runs scans, reclaims, undos and weekly reports on the fake
site: every account ID written is found, closed accounts are erased and nobody else is
touched, History still pages after an entry in the middle goes, erasing waits for a scan, a
reclaim or an undo, and the page, the download, History and the agent still work afterwards.

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
