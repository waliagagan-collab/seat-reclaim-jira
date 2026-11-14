# Privacy & Security tab: Seat Reclaim for Jira (draft answers)

Draft answers for the personal data parts of the Marketplace Privacy & Security tab, checked against manifest.yml and src/ on 14 November 2026, when the weekly personal data report was added. Nothing here has been entered on the Marketplace. The tab is private, so the answers already there could not be read; answers this file does not mention stay as they are (the drafts in `listing.md`, under "Privacy & Security tab" and the 14 Nov audit's proposed changes). A line starting with CHECK: needs a fact or a decision the code cannot settle.

## Data the app stores

Where: Forge hosted storage (Forge key-value storage, `@forge/kvs`) on the customer's site. Nothing is stored anywhere else.

| What | Personal data | Kept until |
| --- | --- | --- |
| The last list: for each inactive licensed user, the account ID, the Jira products they hold a seat for, the IDs of their product access groups, the names of any admin groups they are in, and how long they have been inactive (a band such as "180–365 days") (`report:dormant:`); and the account IDs on that list, which a reclaim checks against (`report:ids:`) | Yes: account IDs of inactive users | The next scan replaces the list, or uninstall. The row of an account Atlassian reports closed is taken out by the weekly personal data report |
| The list's totals: when the scan ran, the period, licensed, active and inactive users, Atlassian's seat counts and plan limit per product, which group gives which product (group IDs and names), inactive seats per product, fixed warning sentences (`report:meta`) | No | The next scan, or uninstall |
| The scan in progress or the last one: phase, cursors (group IDs and names, positions, a Jira page token), counters, times, fixed warning sentences, an error text if the scan failed, and the account ID of the admin who started it (`scan:state`) | Yes: the account ID of the admin who started the scan. An error text from Jira can quote an account ID | Overwritten by the next scan, or uninstall |
| Working data while a scan runs: each licensed user's account ID with the products and access groups they hold, the accounts seen acting, and the inactive users found so far (`scan:{run}:users:`, `scan:{run}:active:`, `scan:{run}:dormant:`) | Yes: account IDs of every licensed user | Deleted when the scan ends, fails or is cancelled. A scan that stopped without ending keeps it until the next scan starts |
| History: one entry per reclaim, with the account ID of the person, of the admin who approved it and of the admin who undid it, the time, the ID and name of each group left, the products freed and, when Jira refused a change, Jira's error text (`log:entry:`); and the order of the entries, entry IDs only (`log:index`, `log:index:<n>`, `log:index:meta`) | Yes: account IDs of the person and the admins. Jira's error text can quote an account ID | For good, so every reclaim can be undone, or uninstall. An entry about an account Atlassian reports closed is deleted by the weekly personal data report |
| The latest action on each person, to mark their row: the entry it belongs to, its outcome and time, or why the last try changed nothing (a fixed sentence or Jira's error text) (`log:latest:`) | Yes: account IDs of the people reclaimed or tried | Replaced by the next action on the same person, or uninstall. Taken out for an account Atlassian reports closed |
| The protected list: the account ID of each protected person, when, and the account ID of the admin who protected them (`protected`) | Yes: account IDs of protected people and of admins | Until an admin unprotects the person, or uninstall. A closed person's entry is taken out; a closed admin's account ID is cleared |
| When a reclaim or an undo last started, a time only (`action:started`) | No | Overwritten by the next reclaim or undo, or uninstall |
| Settings: the yearly price of one seat per product, and the date an admin closed the one-time review request (`settings`) | No | Changed again, or uninstall |
| Personal data report: where this week's report is, and the totals of the last one (`pdr:state`, positions and counts only); the account IDs gathered for it (`pdr:ids:<n>`), the closed ones among them (`pdr:closed:<n>`) and those Atlassian says changed their profile (`pdr:updated:<n>`); a lock so two runs never overlap (`pdr:lock`) | Yes, while a report runs: the gathered, closed and changed account IDs | `pdr:ids:`, `pdr:closed:` and `pdr:updated:` are deleted when the report ends, normally within the hour it started. The lock is deleted when a run ends, and is free after 2 minutes if a run was stopped. The totals stay until the next report |

Read but never stored: display names and email addresses (where a user's profile lets apps see them), read from Jira when the list or History is shown or downloaded, or when the Rovo agent answers an admin; the issue data Jira returns to the activity search (comment text, changed field values), of which only who acted and when is used.
Changes the app makes on the site: it takes a person out of product access groups (reclaim) and puts them back (undo), as the signed-in site admin, after the admin confirms. Nothing else.
Queue events and scheduled triggers: each queue event of a scan carries only the run ID and a sequence number. An hourly scheduled trigger runs the weekly personal data report (below), whatever the licence says.

**Data stored** (the paragraph on the tab, to replace the one there): Account IDs of the inactive users on the last list, with the products they hold, the IDs of their product access groups, the names of any admin groups they are in and an inactivity band derived by the app; the account ID of the admin who started the last scan; while a scan runs, the account ID of each licensed user with the products and access groups they hold (deleted when the scan ends); the reclaim history (account IDs of the person, the approving admin and the admin who undid it, times, the ID and name of each group changed, the products freed and, when Jira refused a change, Jira's error text) and the latest action on each person; the protected list (account IDs of the protected person and of the admin who protected them, and when); Atlassian's seat counts, scan progress, the seat prices an admin enters, and the date an admin closed the review request. Display names and email addresses are never stored; they are looked up from Jira when the list or History is viewed or exported, or when the Rovo agent answers an admin. No issue content, comments or attachments are stored. The account IDs are reported to Atlassian once a week, and those of closed accounts are erased. Uninstalling the app deletes all of it.

## Personal data

- Stores personal data: **Yes**. Atlassian account IDs of: the inactive licensed users on the last list; the admin who started the last scan; while a scan runs, every licensed user; the people reclaimed and the admins who approved or undid each reclaim (History, kept for good so every reclaim can be undone); and the protected people with the admins who protected them.
- Processes personal data without storing it: display names and email addresses, read from Jira when the list or History is shown, downloaded or read by the Rovo agent. The agent passes them to Atlassian Rovo, within Atlassian.
- Developer console, Distribution, "Does your app store personal data?": Yes (account IDs are kept longer than 24 hours). On the Marketplace form the same Yes ticks the Personal Data Reporting API acknowledgment, which is true: the app calls it.
- Closed Atlassian accounts: the app uses Forge's personal data reporting API (`privacy.reportPersonalData`, scope `report:personal-data`). Once a week it reports every account ID it keeps, 90 per call; a new report starts 7 days after the last call of the one before, so no account is reported more often than once in 7 days. For each account Atlassian reports closed it erases the account ID everywhere it keeps it: the account's row on the last list is taken out, so it can no longer be reclaimed; every History entry about the person is deleted (Undo could only give a closed account its groups back); their protected-list entry and the note on their row are taken out; the account ID of an admin who approved or undid a reclaim, started a scan or protected someone is cleared, and where History names that admin it shows "Closed account"; an account ID quoted in a stored error text becomes "(closed account)"; and the account is taken out of the working data of a scan. The totals already shown stay as the scan counted them until the next scan counts again; the page, the download and the Rovo agent say how many users on the list are no longer listed. Erasing waits while a scan is running, and for a minute after a reclaim or an undo starts. The app keeps no names or emails, so an "updated" answer needs nothing.
- CHECK: the GDPR and CCPA answers already on the tab. `listing.md` says TELCOMA Global is a GDPR processor; this change does not alter that.

## Retention and deletion

- Everything in the table is kept while the app is installed, unless the table says otherwise.
- On uninstall: Atlassian deletes the app's Forge storage for that site under Forge's data deletion rules. We keep no copy and have no access to it from outside the app.
- Closed accounts: erased by the weekly personal data report that names them, normally within the hour of that report's call to Atlassian; if a scan, a reclaim or an undo is running, once it ends.
- On request: running a new scan replaces the list; unprotecting removes a protected entry; uninstalling deletes everything, History included.

## Outside Atlassian

Unchanged by this change. The app makes no requests outside Atlassian (manifest.yml declares no `permissions.external` and no `remotes`). The weekly report goes to Atlassian's own personal data reporting service.

## Logging

- Logs End-User Data: No. The code logs only these lines: from the hourly trigger, "Personal data report:" with whether it ran, the step it reached, the error message if a call failed (an HTTP status or a fixed sentence), and at the end of a report its totals (how many accounts, closed, values changed, skipped); and from the Rovo agent, "agent action failed:" with the error message when an action could not read the app's data. No account ID, name or email is logged.
- Shares logs with third parties: No.

## Scope justifications

One line per scope, in manifest.yml order, ready to paste. The first eight are those of the scope table in `listing.md`, with the `read:jira-work` line the 14 Nov audit proposed (it names the two permission checks); the last is new.

- `read:jira-user`: Read a user's groups during a scan (to see whether they are in an admin group) and again just before a reclaim, and fall back to the site directory if roles are unreadable.
- `read:jira-work`: Search recently updated issues and read changelog, comment and worklog authors to decide who was active, and ask Jira per user which issues they updated. Issue content is never stored. The same scope covers the two permission checks: whether the signed-in user is a Jira administrator (every call), and whether a person about to be reclaimed is one (`POST /rest/api/3/permissions/check`).
- `read:application-role:jira`: Read the application roles and the groups that grant each Jira product, and Atlassian's own per-product seat counts shown before and after a reclaim.
- `read:group:jira`: List the members of the product access groups.
- `read:user:jira`: Read active flag and account type to leave out bots and customers; display name and email at display time.
- `read:avatar:jira`: Required alongside `read:user:jira` by the group-member endpoint; avatars are not shown.
- `write:group:jira`: The one write scope: remove a user from a product access group (reclaim) and add them back (undo), both as the signed-in site admin after they confirm. Jira requires a site admin for both.
- `storage:app`: Keep scan progress, the report, the protected list, the reclaim history and seat prices in Forge hosted storage.
- `report:personal-data`: Report the account IDs the app keeps to Atlassian once a week (privacy.reportPersonalData), so the data of accounts Atlassian reports closed is erased.
