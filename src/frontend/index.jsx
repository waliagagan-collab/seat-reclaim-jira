import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  Checkbox,
  DynamicTable,
  Frame,
  Inline,
  Label,
  Lozenge,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTransition,
  SectionMessage,
  Select,
  Spinner,
  Stack,
  Strong,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  Textfield,
} from '@forge/react';
import { invoke, view } from '@forge/bridge';
import { licenseGate, licenseMessage } from '../lib/scan.js';

const PERIODS = [30, 60, 90, 180, 365].map((d) => ({
  label: `No activity in ${d} days`,
  value: String(d),
}));

// Must match RECLAIM_BATCH in src/index.js; the backend caps it anyway.
const BATCH = 5;

const phaseText = (s) => {
  switch (s?.phase) {
    case 'roles':
      return 'Reading license groups';
    case 'members':
    case 'directory':
      return `Listing licensed users — ${s.usersFound ?? 0} found`;
    case 'issues':
      return `Scanning recent activity — ${s.issuesScanned ?? 0} issues`;
    case 'verify':
      return `Checking candidates — ${s.verified ?? 0} checked, ${s.dormantFound ?? 0} inactive so far`;
    case 'finalize':
      return 'Building the list';
    default:
      return 'Working';
  }
};

const fmtDate = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '—');
const fmtTime = (iso) => (iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') : '—');
const join = (xs) => (xs ?? []).join(', ') || '—';

/** Status shown for a row: what happened last, or whether it can be reclaimed. */
function rowStatus(u) {
  const last = u.lastAction?.status;
  if (last === 'reclaimed') return { text: 'Reclaimed', appearance: 'success' };
  if (last === 'partial') return { text: 'Partly reclaimed', appearance: 'moved' };
  if (u.isProtected) return { text: 'Protected', appearance: 'default' };
  if (!u.reclaimable) return { text: 'Can’t reclaim', appearance: 'default' };
  return { text: 'Ready', appearance: 'inprogress' };
}

const canSelect = (u) =>
  u.reclaimable && !u.isProtected && !['reclaimed', 'partial'].includes(u.lastAction?.status);

// ---------------------------------------------------------------------------
// Inactive users tab
// ---------------------------------------------------------------------------

function AuditPanel({ gate, onChanged, version }) {
  const [period, setPeriod] = useState(PERIODS[2]);
  const [status, setStatus] = useState(null);
  const [rows, setRows] = useState([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [seatCost, setSeatCost] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [progress, setProgress] = useState(null);
  const [outcome, setOutcome] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const res = await invoke('getStatus');
      setStatus(res);
      return res;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const state = status?.state;
  const report = status?.report;
  const running = state?.status === 'running';
  const stale = Boolean(status?.stale);

  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [running, refresh]);

  const loadPage = useCallback(async (index) => {
    try {
      const res = await invoke('getPage', { index });
      setRows(res.rows ?? []);
      setPageIndex(index);
    } catch (err) {
      setMessage(`Could not load that page of results: ${err?.message ?? 'no response'}.`);
    }
  }, []);

  const generatedAt = report?.generatedAt;
  useEffect(() => {
    if (generatedAt && !running) {
      setSelected(new Set());
      loadPage(0);
    }
  }, [generatedAt, running, loadPage]);

  // An undo in the History tab changes what this list should show.
  const [seenVersion, setSeenVersion] = useState(version);
  useEffect(() => {
    if (version === seenVersion) return;
    setSeenVersion(version);
    if (generatedAt && !running) loadPage(pageIndex);
  }, [version, seenVersion, generatedAt, running, loadPage, pageIndex]);

  const start = async () => {
    setBusy(true);
    setMessage(null);
    setOutcome(null);
    try {
      const res = await invoke('startScan', { days: Number(period.value) });
      if (!res?.ok) setMessage(res?.error ?? 'Could not start the scan.');
      await refresh();
    } catch (err) {
      setMessage(
        `Could not start the scan: ${err?.message ?? 'the app did not respond'}. Try again, and if it keeps happening email support@telcomaglobal.com.`
      );
    } finally {
      setBusy(false);
    }
  };

  const toggle = (accountId, on) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(accountId);
      else next.delete(accountId);
      return next;
    });

  const selectAllReady = () => setSelected(new Set(rows.filter(canSelect).map((u) => u.accountId)));

  const protect = async (u, on) => {
    try {
      await invoke('setProtected', { accountId: u.accountId, protected: on });
      toggle(u.accountId, false);
      await loadPage(pageIndex);
    } catch {
      setMessage('Could not update the protected list. Try again.');
    }
  };

  const chosen = useMemo(() => rows.filter((u) => selected.has(u.accountId)), [rows, selected]);
  const yearlyEstimate =
    Number(seatCost) > 0 && chosen.length
      ? Math.round(chosen.reduce((n, u) => n + (u.freedProducts?.length ?? 0), 0) * Number(seatCost))
      : null;

  /** Reclaim in small batches; read Atlassian's seat counts before and after. */
  const runReclaim = async () => {
    setConfirmOpen(false);
    setOutcome(null);
    setMessage(null);
    const ids = chosen.map((u) => u.accountId);
    const results = [];
    let before = null;
    let after = null;
    try {
      before = await invoke('getSeatCounts');
    } catch {
      /* the counts are a bonus; the reclaim does not depend on them */
    }
    for (let i = 0; i < ids.length; i += BATCH) {
      setProgress(`Reclaiming seats — ${Math.min(i + BATCH, ids.length)} of ${ids.length} users`);
      try {
        const res = await invoke('reclaim', { accountIds: ids.slice(i, i + BATCH) });
        if (!res?.ok) {
          results.push(...ids.slice(i, i + BATCH).map((accountId) => ({ accountId, ok: false, error: res?.error })));
          if (res?.unlicensed || res?.forbidden) break;
        } else {
          results.push(...(res.results ?? []));
        }
      } catch (err) {
        results.push(
          ...ids.slice(i, i + BATCH).map((accountId) => ({ accountId, ok: false, error: err?.message ?? 'No response' }))
        );
      }
    }
    try {
      after = await invoke('getSeatCounts');
    } catch {
      /* see above */
    }
    setProgress(null);
    setSelected(new Set());
    setOutcome({ results, before, after });
    await loadPage(pageIndex);
    onChanged?.();
  };

  const products = report?.products ?? [];
  const hasEmails = rows.some((r) => r.email);
  const readyOnPage = rows.filter(canSelect).length;

  return (
    <Stack space="space.200">
      <SectionMessage title="How it works">
        <Text>
          Run a scan to find licensed users who did <Strong>nothing in Jira</Strong> in the period:
          no status change, field edit, comment, logged work, or issue created or reported. Every
          candidate is checked against all issues on the site. Then pick who to reclaim. The app
          takes them out of the groups that give them that product, which frees the seat. Nothing
          changes until you confirm, and every change can be undone from the History tab.
        </Text>
      </SectionMessage>

      <Inline space="space.100" alignBlock="end">
        <Box xcss={{ minWidth: '230px' }}>
          <Label labelFor="period">Period</Label>
          <Select
            id="period"
            options={PERIODS}
            value={period}
            onChange={setPeriod}
            isDisabled={(running && !stale) || !gate.allowed}
          />
        </Box>
        <Button appearance="primary" onClick={start} isDisabled={(running && !stale) || busy || !gate.allowed}>
          {running && !stale ? 'Scanning…' : stale ? 'Restart scan' : 'Find inactive users'}
        </Button>
        {running && (
          <Button
            appearance="subtle"
            onClick={() =>
              invoke('cancelScan')
                .then(refresh)
                .catch(() => setMessage('Could not cancel the scan. It will stop on its own.'))
            }
          >
            Cancel
          </Button>
        )}
      </Inline>

      {message && (
        <SectionMessage appearance="warning">
          <Text>{message}</Text>
        </SectionMessage>
      )}

      {running && !stale && (
        <Inline space="space.100" alignBlock="center">
          <Spinner size="small" />
          <Text>{phaseText(state)}. You can leave this page — the scan continues.</Text>
        </Inline>
      )}

      {stale && (
        <SectionMessage appearance="warning" title="This scan appears to be stuck">
          <Text>It has not made progress for over 20 minutes. Restarting is safe — a scan changes nothing.</Text>
        </SectionMessage>
      )}

      {state?.status === 'failed' && (
        <SectionMessage appearance="error" title="Scan failed">
          <Text>{state.error}</Text>
        </SectionMessage>
      )}

      {progress && (
        <Inline space="space.100" alignBlock="center">
          <Spinner size="small" />
          <Text>{progress}. Keep this page open.</Text>
        </Inline>
      )}

      {outcome && <Outcome outcome={outcome} />}

      {report && (
        <Stack space="space.150">
          <Inline space="space.200" alignBlock="center">
            <Text>
              <Strong>{report.totalUsers}</Strong> licensed
            </Text>
            <Text>
              <Strong>{report.activeUsers}</Strong> active
            </Text>
            <Lozenge appearance={report.dormantCount ? 'removed' : 'success'}>
              {report.dormantCount} inactive
            </Lozenge>
            <Text>
              {report.days}-day window · scanned {fmtDate(report.generatedAt)}
            </Text>
          </Inline>

          {products.length > 0 && (
            <DynamicTable
              head={{
                cells: [
                  { key: 'product', content: 'Product' },
                  { key: 'seats', content: 'Seats at scan time' },
                  { key: 'limit', content: 'Plan limit' },
                  { key: 'inactive', content: 'Inactive' },
                ],
              }}
              rows={products.map((p) => ({
                key: p.key,
                cells: [
                  { key: `name-${p.name}`, content: p.name },
                  { key: `seats-${p.userCount ?? 0}`, content: p.userCount ?? '—' },
                  { key: `limit-${p.numberOfSeats ?? 0}`, content: p.hasUnlimitedSeats ? 'Unlimited' : (p.numberOfSeats ?? '—') },
                  { key: `inactive-${report.dormantByProduct?.[p.name] ?? 0}`, content: report.dormantByProduct?.[p.name] ?? 0 },
                ],
              }))}
            />
          )}

          {(report.warnings ?? []).map((w) => (
            <SectionMessage key={w} appearance="warning">
              <Text>{w}</Text>
            </SectionMessage>
          ))}

          {report.dormantCount === 0 ? (
            <SectionMessage appearance="success" title="No inactive users">
              <Text>
                Every one of the {report.totalUsers} licensed users was active in the last {report.days} days.
              </Text>
            </SectionMessage>
          ) : (
            <Stack space="space.150">
              <Inline space="space.100" alignBlock="center">
                <Button onClick={selectAllReady} isDisabled={!readyOnPage || !gate.allowed}>
                  Select all ready ({readyOnPage})
                </Button>
                <Button appearance="subtle" onClick={() => setSelected(new Set())} isDisabled={!selected.size}>
                  Clear
                </Button>
                <Button
                  appearance="danger"
                  onClick={() => setConfirmOpen(true)}
                  isDisabled={!chosen.length || Boolean(progress) || !gate.allowed}
                >
                  Reclaim seats for {chosen.length} {chosen.length === 1 ? 'user' : 'users'}
                </Button>
              </Inline>

              <DynamicTable
                head={{
                  cells: [
                    { key: 'pick', content: '' },
                    { key: 'name', content: 'User', isSortable: true },
                    { key: 'products', content: 'Products', isSortable: true },
                    { key: 'last', content: 'Last Jira activity', isSortable: true },
                    { key: 'status', content: 'Reclaim', isSortable: true },
                    { key: 'protect', content: '' },
                  ],
                }}
                rows={rows.map((u) => {
                  const st = rowStatus(u);
                  return {
                    key: u.accountId,
                    cells: [
                      {
                        key: `pick-${selected.has(u.accountId) ? 1 : 0}`,
                        content: (
                          <Checkbox
                            label=""
                            value={u.accountId}
                            isChecked={selected.has(u.accountId)}
                            isDisabled={!canSelect(u) || !gate.allowed}
                            onChange={(e) => toggle(u.accountId, Boolean(e?.target?.checked))}
                          />
                        ),
                      },
                      {
                        key: `name-${String(u.displayName).toLowerCase()}`,
                        content: (
                          <Stack space="space.0">
                            <Text>{u.displayName}</Text>
                            {u.email && <Text size="small">{u.email}</Text>}
                          </Stack>
                        ),
                      },
                      { key: `products-${join(u.products)}`, content: join(u.products) },
                      {
                        key: `last-${u.severity ?? 0}`,
                        content: <Lozenge appearance={u.severity >= 2 ? 'removed' : 'moved'}>{u.label}</Lozenge>,
                      },
                      {
                        key: `status-${st.text}`,
                        content: (
                          <Stack space="space.050">
                            <Lozenge appearance={st.appearance}>{st.text}</Lozenge>
                            {!u.reclaimable && u.reason && <Text size="small">{u.reason}</Text>}
                            {canSelect(u) && <Text size="small">Frees: {join(u.freedProducts)}</Text>}
                          </Stack>
                        ),
                      },
                      {
                        key: `protect-${u.isProtected ? 1 : 0}`,
                        content: (
                          <Button appearance="subtle" spacing="compact" onClick={() => protect(u, !u.isProtected)}>
                            {u.isProtected ? 'Unprotect' : 'Protect'}
                          </Button>
                        ),
                      },
                    ],
                  };
                })}
                rowsPerPage={25}
                defaultSortKey="last"
                defaultSortOrder="DESC"
              />

              {!hasEmails && (
                <Text>Emails are hidden because those users' profile privacy settings don't share them with apps.</Text>
              )}

              {report.pages > 1 && (
                <Inline space="space.100" alignBlock="center">
                  <Button isDisabled={pageIndex === 0} onClick={() => loadPage(pageIndex - 1)}>
                    Previous
                  </Button>
                  <Text>
                    Page {pageIndex + 1} of {report.pages}
                  </Text>
                  <Button isDisabled={pageIndex >= report.pages - 1} onClick={() => loadPage(pageIndex + 1)}>
                    Next
                  </Button>
                </Inline>
              )}

              <Inline space="space.100" alignBlock="end">
                <Box xcss={{ maxWidth: '220px' }}>
                  <Label labelFor="seat">Yearly cost of one seat</Label>
                  <Textfield id="seat" value={seatCost} onChange={(e) => setSeatCost(e.target.value)} placeholder="e.g. 100" />
                </Box>
                {yearlyEstimate !== null && (
                  <Text>
                    About <Strong>{yearlyEstimate.toLocaleString()}</Strong> a year for the {chosen.length} selected.
                  </Text>
                )}
              </Inline>
              <Text size="small">
                Freeing a seat lowers the number of users Atlassian counts. What your bill does depends on your plan:
                Atlassian bills by user tier, usually from the next billing cycle, so the price may not drop until the
                count falls below a tier.
              </Text>

              <Frame key={generatedAt} resource="export-frame" />
            </Stack>
          )}
        </Stack>
      )}

      <ModalTransition>
        {confirmOpen && (
          <Modal onClose={() => setConfirmOpen(false)}>
            <ModalHeader>
              <ModalTitle appearance="danger">
                Reclaim seats for {chosen.length} {chosen.length === 1 ? 'user' : 'users'}?
              </ModalTitle>
            </ModalHeader>
            <ModalBody>
              <Stack space="space.150">
                <Text>
                  Each person below is taken out of the listed groups, which removes their access to the listed
                  products and frees those seats. Their Atlassian account stays active. Groups are re-checked live
                  before each change, and you can undo any of it from the History tab.
                </Text>
                <DynamicTable
                  head={{
                    cells: [
                      { key: 'u', content: 'User' },
                      { key: 'g', content: 'Leaves groups' },
                      { key: 'p', content: 'Loses access to' },
                    ],
                  }}
                  rows={chosen.map((u) => ({
                    key: u.accountId,
                    cells: [
                      { key: 'u', content: u.displayName },
                      { key: 'g', content: join(u.removeGroups) },
                      { key: 'p', content: join(u.freedProducts) },
                    ],
                  }))}
                  rowsPerPage={10}
                />
              </Stack>
            </ModalBody>
            <ModalFooter>
              <Button appearance="subtle" onClick={() => setConfirmOpen(false)}>
                Cancel
              </Button>
              <Button appearance="danger" onClick={runReclaim}>
                Reclaim {chosen.length} {chosen.length === 1 ? 'seat' : 'seats'}
              </Button>
            </ModalFooter>
          </Modal>
        )}
      </ModalTransition>
    </Stack>
  );
}

/** What a reclaim run did, with Atlassian's own counts before and after. */
function Outcome({ outcome }) {
  const { results, before, after } = outcome;
  const done = results.filter((r) => r.ok);
  const skipped = results.filter((r) => !r.ok && r.skipped);
  const failed = results.filter((r) => !r.ok && !r.skipped);
  const counts =
    before?.products && after?.products
      ? before.products.map((p) => ({
          name: p.name,
          before: p.userCount,
          after: after.products.find((q) => q.key === p.key)?.userCount ?? p.userCount,
        }))
      : [];
  const changed = counts.filter((c) => c.before !== c.after);

  return (
    <SectionMessage
      appearance={failed.length ? 'warning' : 'success'}
      title={`Reclaimed seats for ${done.length} of ${results.length} ${results.length === 1 ? 'user' : 'users'}`}
    >
      <Stack space="space.100">
        {changed.length > 0 && (
          <Text>
            Atlassian now counts: {changed.map((c) => `${c.name} ${c.before} → ${c.after}`).join(' · ')}
          </Text>
        )}
        {skipped.map((r) => (
          <Text key={r.accountId}>
            Skipped {r.displayName}: {r.error}
          </Text>
        ))}
        {failed.map((r) => (
          <Text key={r.accountId}>
            Not done for {r.displayName ?? r.accountId}: {r.error}
          </Text>
        ))}
        {done.length > 0 && <Text>Every change is in the History tab, where you can undo it.</Text>}
      </Stack>
    </SectionMessage>
  );
}

// ---------------------------------------------------------------------------
// History tab
// ---------------------------------------------------------------------------

const STATUS = {
  reclaimed: { text: 'Reclaimed', appearance: 'success' },
  partial: { text: 'Partly reclaimed', appearance: 'moved' },
  restored: { text: 'Undone', appearance: 'default' },
};

function HistoryPanel({ version, onChanged }) {
  const [data, setData] = useState(null);
  const [page, setPage] = useState(0);
  const [working, setWorking] = useState(null);
  const [message, setMessage] = useState(null);

  const load = useCallback(async (p) => {
    try {
      const res = await invoke('getHistory', { page: p });
      setData(res);
      setPage(p);
    } catch (err) {
      setMessage(`Could not load the history: ${err?.message ?? 'no response'}.`);
    }
  }, []);

  useEffect(() => {
    load(0);
  }, [load, version]);

  const undo = async (entry) => {
    setWorking(entry.id);
    setMessage(null);
    try {
      const res = await invoke('undo', { entryId: entry.id });
      if (!res?.ok) setMessage(`Undo was not complete for ${entry.displayName}: ${res?.error ?? 'unknown error'}`);
      await load(page);
      onChanged?.();
    } catch (err) {
      setMessage(`Undo failed: ${err?.message ?? 'no response'}.`);
    } finally {
      setWorking(null);
    }
  };

  if (data?.forbidden) {
    return (
      <SectionMessage appearance="error" title="Access denied">
        <Text>{data.error}</Text>
      </SectionMessage>
    );
  }

  const entries = data?.entries ?? [];
  return (
    <Stack space="space.200">
      <Text>
        Every reclaim, who approved it and which groups each person left. Undo puts the person back in exactly those
        groups.
      </Text>
      {message && (
        <SectionMessage appearance="warning">
          <Text>{message}</Text>
        </SectionMessage>
      )}
      {!data ? (
        <Spinner />
      ) : entries.length === 0 ? (
        <Text>Nothing reclaimed yet.</Text>
      ) : (
        <DynamicTable
          head={{
            cells: [
              { key: 'when', content: 'When (UTC)' },
              { key: 'user', content: 'User' },
              { key: 'products', content: 'Products freed' },
              { key: 'groups', content: 'Groups left' },
              { key: 'by', content: 'Approved by' },
              { key: 'status', content: 'Status' },
              { key: 'act', content: '' },
            ],
          }}
          rows={entries.map((e) => {
            const st = STATUS[e.status] ?? { text: e.status, appearance: 'default' };
            return {
              key: e.id,
              cells: [
                { key: 'when', content: fmtTime(e.at) },
                { key: 'user', content: e.displayName },
                { key: 'products', content: join(e.freedProducts) },
                { key: 'groups', content: join((e.groups ?? []).filter((g) => g.ok).map((g) => g.name)) },
                { key: 'by', content: e.byName ?? '—' },
                {
                  key: 'status',
                  content: (
                    <Stack space="space.050">
                      <Lozenge appearance={st.appearance}>{st.text}</Lozenge>
                      {e.status === 'restored' && (
                        <Text size="small">
                          {fmtTime(e.restoredAt)} by {e.restoredByName ?? '—'}
                        </Text>
                      )}
                    </Stack>
                  ),
                },
                {
                  key: 'act',
                  content:
                    e.status === 'restored' ? null : (
                      <Button spacing="compact" onClick={() => undo(e)} isDisabled={Boolean(working)}>
                        {working === e.id ? 'Undoing…' : 'Undo'}
                      </Button>
                    ),
                },
              ],
            };
          })}
        />
      )}
      {data?.pages > 1 && (
        <Inline space="space.100" alignBlock="center">
          <Button isDisabled={page === 0} onClick={() => load(page - 1)}>
            Newer
          </Button>
          <Text>
            Page {page + 1} of {data.pages}
          </Text>
          <Button isDisabled={page >= data.pages - 1} onClick={() => load(page + 1)}>
            Older
          </Button>
        </Inline>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const App = () => {
  const [ctx, setCtx] = useState(null);
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const [access, setAccess] = useState(null);

  useEffect(() => {
    view
      .getContext()
      .then(setCtx)
      .catch(() => setCtx({}));
    // One cheap call up front tells us whether this person may use the app.
    invoke('getStatus')
      .then(setAccess)
      .catch(() => setAccess({}));
  }, []);

  const gate = licenseGate(ctx?.license, ctx?.environmentType);
  const trialEnds =
    gate.reason === 'trial' && ctx?.license?.trialEndDate
      ? new Date(ctx.license.trialEndDate).toISOString().slice(0, 10)
      : null;

  if (access?.forbidden) {
    return (
      <SectionMessage appearance="error" title="Access denied">
        <Text>{access.error}</Text>
      </SectionMessage>
    );
  }

  return (
    <Stack space="space.200">
      {!gate.allowed && (
        <SectionMessage appearance="warning" title="Subscription needed">
          <Text>{licenseMessage(gate, ctx?.license)}</Text>
        </SectionMessage>
      )}
      {trialEnds && (
        <SectionMessage appearance="information">
          <Text>Your free trial runs until {trialEnds}.</Text>
        </SectionMessage>
      )}
      <Tabs id="seat-reclaim-tabs">
        <TabList>
          <Tab>Inactive users</Tab>
          <Tab>History</Tab>
        </TabList>
        <TabPanel>
          <Box xcss={{ paddingTop: 'space.200', width: '100%' }}>
            <AuditPanel gate={gate} version={version} onChanged={bump} />
          </Box>
        </TabPanel>
        <TabPanel>
          <Box xcss={{ paddingTop: 'space.200', width: '100%' }}>
            <HistoryPanel version={version} onChanged={bump} />
          </Box>
        </TabPanel>
      </Tabs>
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
