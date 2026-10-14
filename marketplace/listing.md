# Marketplace listing — Seat Reclaim for Jira

Copy for the Atlassian Marketplace listing, checked against the field limits.
Assets are in `assets/` (logo, banners) and `assets/2026-10-12/` (highlights, 1840×900).

---

## Name (60 / 60 characters)

Seat Reclaim: Remove Inactive Users & Free Licenses for Jira

## Tagline (105 / 130, no trailing punctuation)

Find inactive Jira users and free their seats after you confirm. Every change is logged and can be undone

## Summary (234 / 250)

Finds licensed Jira users who did nothing for 30 to 365 days, verified against every issue, and frees their seats after you confirm by taking them out of product access groups. Admins are never touched, and every change can be undone.

## Categories and keywords

- Categories: Administrative tools; Data and analytics (match License Audit)
- Keywords (4): Audit, User permissions, Compliance, Reporting

## More details (785 / 250–1000)

**Every Jira seat you pay for should belong to someone who uses Jira.**

Seat Reclaim lists the licensed users who have done **nothing in Jira** in a period you choose (no status change, field edit, comment, logged work, or issue created) and frees their seats after you confirm.

- Each user shows what reclaiming would free, or why it can't: admin groups, you, and your protected list are never touched.
- Select users, check the summary of groups and products, confirm. Activity and groups are re-checked live first.
- See Atlassian's seat count before and after, and what inactive seats cost a year.
- History logs every change; Undo restores exactly the groups removed.

**Nothing to set up.** No API key. It takes people out of product access groups only; accounts stay active. **Runs on Atlassian;** no servers of ours.

## Highlights (title ≤ 50, description ≤ 220)

1. **Free seats and see the count drop** — Select inactive users, confirm, and their seats are free. The page shows Atlassian's own seat count before and after, and what the inactive seats cost a year.
   Image: `assets/2026-10-12/highlight-1-result.png`
2. **Check every change before it happens** — A summary lists the groups each person leaves and the products they lose. Activity and groups are re-checked live before each change. Admins, you and anyone you protect are never touched.
   Image: `assets/2026-10-12/highlight-2-confirm.png`
3. **Undo any reclaim** — History records whose seat was reclaimed, who approved it, when, and which groups they left. Undo puts the person back in exactly those groups.
   Image: `assets/2026-10-12/highlight-3-history.png`

Hero: banner image `assets/banner-1920x1200.png` (or 1120×548 where asked).

## Version step

- Release summary (66 / 80): First release: find inactive users and free their seats, with undo
- Release notes: Finds licensed Jira users with no activity in a period you choose, verified against every issue, and frees their seats after you confirm by taking them out of product access groups. Admin groups, the person running it and protected users are never reclaimed. History logs every change and Undo restores exactly the groups removed. Includes a read-only Rovo agent.
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
| `read:jira-user` | Read a user's current groups just before a reclaim, and fall back to the site directory if roles are unreadable. |
| `read:jira-work` | Search recently updated issues and read changelog, comment and worklog authors to decide who was active. Issue content is never stored. |
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
