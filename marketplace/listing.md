# Marketplace listing — Seat Reclaim for Jira

Copy for the Atlassian Marketplace listing, checked against the field limits.
Assets are in `assets/` (logo, banners) and `assets/2026-10-12/` (highlights, 1840×900).

---

## Name (60 / 60 characters)

Seat Reclaim: Remove Inactive Users & Free Licenses for Jira

## Tagline (105 / 130, no trailing punctuation)

Find inactive Jira users and free their seats after you confirm. Every change is logged and can be undone

## Summary (249 / 250)

Finds licensed Jira users who did nothing for 30 to 365 days, checked against all issues the app can see, and frees their seats after you confirm by taking them out of product access groups. Jira admins are never reclaimed. Any change can be undone.

## Categories and keywords

- Categories: Administrative tools; Data and analytics (match License Audit)
- Keywords (4): Audit, User permissions, Compliance, Reporting

## More details (947 / 250–1000)

**Every Jira seat you pay for should belong to someone who uses Jira.**

Seat Reclaim lists the licensed users who have done **nothing in Jira** in a period you choose (no status change, field edit, comment, logged work, or issue created) and frees their seats after you confirm.

- Each user shows what reclaiming would free, or why it can't. Jira admins, anyone in a group with "admin" in its name, you, and your protected list are never reclaimed.
- Select users, check the summary of groups and products, confirm. Activity, groups and admin rights are re-checked live first. Leaving a group also removes anything else that group grants.
- See Atlassian's seat count before and after, and what inactive seats cost a year.
- History logs every change; Undo restores exactly the groups removed.

**Nothing to set up.** No API key. It takes people out of product access groups only; accounts stay active. **Runs on Atlassian;** no servers of ours.

## Highlights (title ≤ 50, description ≤ 220)

1. **Free seats and see the count drop** — Select inactive users, confirm, and their seats are free. The page shows Atlassian's own seat count before and after, and what the inactive seats cost a year.
   Image: `assets/2026-10-12/highlight-1-result.png`
2. **Check every change before it happens** — A summary lists the groups each person leaves and the products they lose. Activity, groups and admin rights are re-checked live before each change. Jira admins, you and anyone you protect are never reclaimed.
   Image: `assets/2026-10-12/highlight-2-confirm.png`
3. **Undo any reclaim** — History records whose seat was reclaimed, who approved it, when, and which groups they left. Undo puts the person back in exactly those groups.
   Image: `assets/2026-10-12/highlight-3-history.png`

Hero: banner image `assets/banner-1920x1200.png` (or 1120×548 where asked).

## Version step

- Release summary (66 / 80): First release: find inactive users and free their seats, with undo
- Release notes: Finds licensed Jira users with no activity in a period you choose, checked against all issues the app can see, and frees their seats after you confirm by taking them out of product access groups. Jira administrators, anyone in a group with "admin" in its name, the person running it and protected users are never reclaimed. History logs every change and Undo restores exactly the groups removed. Includes a read-only Rovo agent.
- License: Commercial. Supported: Yes. EULA: Atlassian's standard EULA.

## Links

- Documentation: https://telcoma.app/apps/seat-reclaim-jira/docs/
- Support: https://telcoma.app/apps/seat-reclaim-jira/support/
- Privacy policy: https://telcoma.app/apps/seat-reclaim-jira/privacy/
- Vendor support and SLA are shared: https://telcoma.app/contact/ and https://telcoma.app/apps/license-audit-jira/sla/

## Pricing (per user per month, each band at its own rate)

| Users | Price |
| --- | --- |
| Up to 10 | Free ("Enable free") |
| 1–100 | $0.90 |
| 101–250 | $0.50 |
| 251–1000 | $0.30 |
| 1001–2500 | $0.22 |
| 2501–5000 | $0.18 |
| 5001–7500 | $0.15 |
| 7501–10000 | $0.13 |
| 10001–15000 | $0.11 |
| 15001–20000 | $0.10 |
| 20001–25000 | $0.09 |
| 25001+ | $0.08 |

Totals: $90 at 100 users, $165 at 250, $240 at 500, $390 at 1,000. Multi-instance prices the same.

---

## Scope justification

| Scope | Why the app needs it |
| --- | --- |
| `read:application-role:jira` | Read the application roles and the groups that grant each Jira product, and Atlassian's own per-product seat counts shown before and after a reclaim. |
| `read:group:jira` | List the members of the product access groups. |
| `read:user:jira` | Read active flag and account type to leave out bots and customers; display name and email at display time. |
| `read:avatar:jira` | Required alongside `read:user:jira` by the group-member endpoint; avatars are not shown. |
| `read:jira-user` | Read a user's groups during a scan (to see whether they are in an admin group) and again just before a reclaim, and fall back to the site directory if roles are unreadable. |
| `read:jira-work` | Search recently updated issues and read changelog, comment and worklog authors to decide who was active, and ask Jira per user which issues they updated. Issue content is never stored. |
| `write:group:jira` | The one write scope: remove a user from a product access group (reclaim) and add them back (undo), both as the signed-in site admin after they confirm. Jira requires a site admin for both. |
| `storage:app` | Keep scan progress, the report, the protected list, the reclaim history and seat prices in Forge hosted storage. |

**Egress:** none. No remote hostnames. **Runs on Atlassian:** eligible.

## Privacy & Security tab (draft answers)

- Stores or processes End-User Data outside Atlassian: **No** (both questions).
- Logs End-User Data: **No**. Shares logs with third parties: **No**.
- Remote REST APIs: **No**.
- Data residency supported: **Yes**. In-scope EUD: Atlassian account IDs of inactive users with their inactivity band and product access group IDs at scan time; the reclaim history (account IDs of the affected user and the approving admin, times, groups changed); the protected list; and the seat prices an admin enters (no personal data) — all in Forge hosted storage. Out-of-scope: scan progress counters and cursors (no personal data). In-scope data stored outside Atlassian: No.
- Compliance certifications: No. CAIQ: No. Requires PATs: No. Security contact: support@telcomaglobal.com (or support@telcoma.app).
- GDPR controller: No. GDPR processor: **Yes** — Atlassian account IDs of licensed users and their product access groups, and the history of reclaims and undos (stored); display names and email addresses (read at display time, never stored).
- CCPA business / service provider: Not applicable. DPA: No.
- Privacy policy: partner policy at https://telcoma.app/apps/seat-reclaim-jira/privacy/

---

## Proposed changes (audit 14 Nov 2026)

Nothing above this line was changed. The public listing was read on 14 Nov 2026 (`/rest/2/addons/com.telcomaglobal.seat-reclaim` and `/versions/latest?hosting=cloud`, version 3.1.0). "Live" below is what that returned. Full reasons are in `audit-2026-11-14.md`.

### What is live and differs from this file

- **Summary** live (237): "Finds licensed Jira users with no real activity for 30 to 365 days, verified against every issue, not just an old Last seen or last login date. Frees their seats after you confirm; admins are never touched and every change can be undone." The words "verified against every issue" are not true: the app sees only the issues it is allowed to browse.
- **More details** live still has the two old bullets: "...or why it can't: admin groups, you, and your protected list are never touched." and "...Activity and groups are re-checked live first."
- **Highlight 2** description live (187): "...Activity and groups are re-checked live before each change. Admins, you and anyone you protect are never touched."
- **Release summary and notes** live: "Minor version update" (the default).
- **Hero** live is a YouTube video (`Op5c97YUVs4`), not the banner image named above. **Gallery** live: no images.
- **Logo** live is the blue chair icon (`../app-icons/png/seat-reclaim-jira-*.png`). The `assets/logo-*.png` and `assets/banner-*.png` files in this folder are the earlier dots design and are not on the listing. Do not upload them.
- Name, tagline, categories, keywords, links, scopes and prices are live as written above.

### Name (60 / 60)

No change: Seat Reclaim: Remove Inactive Users & Free Licenses for Jira

### Tagline (119 / 130, no punctuation at the end)

Remove inactive Jira users from paid seats after you confirm, without deactivating accounts. Every change can be undone

This is the 13 Nov draft, unchanged. It adds "paid seats" and "deactivating", which admins search for, and every part is true of the code.

### Summary (246 / 250)

User management for unused licenses: finds licensed Jira users who did nothing in 30 to 365 days (checked against issues the app can see, not a last active date) and frees their seats after you confirm. Jira admins are never reclaimed. With undo.

The 13 Nov draft said "checked against every issue" and "Admins are never touched". This keeps its search words (user management, unused licenses, last active) and says only what the code does.

### More details (about 964 characters as the editor counts them, limit 1000; 1029 as markdown)

**Every Jira seat you pay for should belong to someone who uses Jira.**

Seat Reclaim lists licensed users who did **nothing in Jira** in a period you choose (no status change, field edit, comment, logged work or issue created) and frees their seats after you confirm.

- Each user shows what a reclaim would free, or why it can't. Jira admins, anyone in a group with "admin" in its name, you and anyone you protect are never reclaimed.
- Activity, groups and admin rights are checked again just before each change. Leaving a group also removes anything else it grants.
- See Atlassian's seat count before and after, and what inactive seats cost a year.
- History logs every change. Undo restores exactly the groups removed.

**Nothing to set up.** No API key. Accounts stay active; people only leave product access groups. **Runs on Atlassian.** Free for up to 10 users.

Only want the report? [License Audit for Jira](https://marketplace.atlassian.com/apps/3306033176) lists inactive users and what their seats cost, read-only.

The last line is the family link from the 13 Nov draft, shortened. Link the words "License Audit for Jira" to https://marketplace.atlassian.com/apps/3306033176 (answers 301 to the listing). "Free for up to 10 users" matches the live price table.

### Highlights (title 50 or less, description 220 or less)

1. **Free seats and see the count drop** (33) — Select inactive users, confirm, and their seats are free. The page shows Atlassian's own seat count before and after, and what the inactive seats cost a year. (158)
   Image: NEW SHOT 1 (the page just after a reclaim). Until then keep the live image.
2. **Check every change before it happens** (36) — A summary lists the groups each person leaves and the products they lose. Activity, groups and admin rights are re-checked live before each change. Jira admins, you and anyone you protect are never reclaimed. (208)
   Image: NEW SHOT 2 (the confirm dialog with today's wording). Until then keep the live image.
3. **Undo any reclaim** (16) — History records whose seat was reclaimed, who approved it, when, and which groups they left. Undo puts the person back in exactly those groups. (143)
   Image: NEW SHOT 3 (History with demo names). Until then keep the live image.

Titles and descriptions 1 and 3 are the live text. Description 2 is the text already in this file, not yet on the listing. The 13 Nov plan put `srj-1-result.png` on highlight 1 and `srj-2-list.png` on highlight 2; neither shows what its highlight says (no before and after count; no confirm summary), so they are not proposed for those places.

### Gallery (caption 220 or less; none live today)

1. growth/listing-screenshots-2026-11-13/out/srj-1-result.png (ready now)
   Caption (143): Inactive users and what their seats cost a year, per product. Seat counts come from Atlassian; the yearly price of a seat is the one you enter.
2. growth/listing-screenshots-2026-11-13/out/srj-3-how.png (ready now)
   Caption (127): How it works, shown on the page: what counts as activity, who is never reclaimed, and what is checked again before each change.
3. NEW SHOT 4 (the list with ready, can't reclaim, protected and reclaimed rows)
   Caption (132): Who can be reclaimed and who cannot, with the reason. Jira admins are never reclaimed, and Protect keeps anyone else you choose out.
4. NEW SHOT 5 (the list filtered to Ready to reclaim, a few rows ticked)
   Caption (167): Search by name or email and filter by product, time inactive and status. Select all ready picks everyone ready in the filtered list. Download the list as CSV or Excel.
5. NEW SHOT 6 (the Rovo agent answering a question)
   Caption (149): Ask the Rovo agent how many seats can be reclaimed, who is ready and what was undone. It only reads: reclaiming stays on the page, after you confirm.

Not proposed: `srj-2-list.png`, `srj-4-history.png` and `srj-5-show.png` from 13 Nov (reasons in the audit file).

### Version step, for the next production release

- Release summary (70 / 80): Admin check per person, complete activity check, History kept for good
- Release notes (577): Jira administrators are never reclaimed: Jira is asked about each person just before the change, and anyone in a group with "admin" in its name is left alone. The activity check now sees every comment and field change a person made. History keeps every reclaim and undo, with no limit. A reclaim that changes nothing is shown on the person's row, not in History. Very long scans pause and continue while the page is open. Two things you may notice: people in an admin-named group now read "Can't reclaim", and someone who was only named as reporter by others can now be listed.

### Scope justification

One row changes, to name the permission checks that were confirmed working on the development site on 12 Nov:

- `read:jira-work`: Search recently updated issues and read changelog, comment and worklog authors to decide who was active, and ask Jira per user which issues they updated. Issue content is never stored. The same scope covers the two permission checks: whether the signed-in user is a Jira administrator (every call), and whether a person about to be reclaimed is one (`POST /rest/api/3/permissions/check`).

### Privacy & Security tab

- Data residency, in-scope End-User Data: Atlassian account IDs of inactive users with their inactivity band, the IDs of their product access groups at scan time and the names of any admin groups they are in; the reclaim history (account IDs of the affected user and the approving admin, times, the ID and name of each group changed, the products freed and, when Jira refused a change, Jira's error text); the protected list (account IDs of the protected user and of the admin who protected them, and when); and the seat prices an admin enters (no personal data). All in Forge hosted storage. Out of scope: scan progress counters and cursors (no personal data). In-scope data stored outside Atlassian: No.
- GDPR processor: Yes. Atlassian account IDs of licensed users, the IDs and names of their product access groups and admin groups, and the history of reclaims and undos (stored); display names and email addresses (read at display time, never stored).
- The public API reports `storesPersonalData: false` for this listing. The app stores Atlassian account IDs. Check the "stores personal data" answer in the listing editor against the answers above.
- Other answers: no change.

### Pricing

No change proposed here. The table above matches the live prices (free up to 10 users; $450 a year at 50 users). The "Totals" line is per month. The 13 Nov market study suggests about $300 a year at 50 users; that is the owner's decision.
