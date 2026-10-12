import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  Checkbox,
  DynamicTable,
  Frame,
  Heading,
  Inline,
  Label,
  Lozenge,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTransition,
  ProgressBar,
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
import { bandOptions, filterRows, fmtMoney, normaliseSeatCosts, scanProgress, yearlySaving } from '../lib/ui.js';

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

// A partly reclaimed user still has groups to leave, so they stay selectable.
const canSelect = (u) => u.reclaimable && !u.isProtected && u.lastAction?.status !== 'reclaimed';

// ---------------------------------------------------------------------------
// Inactive users tab
// ---------------------------------------------------------------------------

const ALL_PRODUCTS = { label: 'All products', value: '' };
const ALL_BANDS = { label: 'Any inactivity', value: '' };
const STATUS_FILTERS = [
  { label: 'Everyone', value: '' },
  { label: 'Ready to reclaim', value: 'ready' },
  { label: 'Can’t reclaim', value: 'blocked' },
  { label: 'Already reclaimed', value: 'done' },
];

const statusGroup = (u) => (u.lastAction?.status === 'reclaimed' ? 'done' : canSelect(u) ? 'ready' : 'blocked');

const HowItWorks = ({ compact, onToggle }) =>
  compact ? (
    <SectionMessage>
      <Inline space="space.100" alignBlock="center" shouldWrap>
        <Text>
          Finds licensed users who did nothing in Jira in the period, then frees their seats after you confirm. Every
          change can be undone from History.
        </Text>
        <Button appearance="subtle" spacing="compact" onClick={onToggle}>
          How it works
        </Button>
      </Inline>
    </SectionMessage>
  ) : (
    <SectionMessage title="How it works">
      <Stack space="space.100">
        <Text>
          Run a scan to find licensed users who did <Strong>nothing in Jira</Strong> in the period: no status change,
          field edit, comment, logged work, or issue created or reported. Every candidate is checked against all issues
          on the site. Then pick who to reclaim. The app takes them out of the groups that give them that product,
          which frees the seat. Admins, app accounts and you are never touched, and you can <Strong>Protect</Strong>{' '}
          anyone else you want left alone. Nothing changes until you confirm; each person's activity and groups are
          re-checked live first, and every change can be undone from the History tab.
        </Text>
        {onToggle && (
          <Box>
            <Button appearance="subtle" spacing="compact" onClick={onToggle}>
              Hide
            </Button>
          </Box>
        )}
      </Stack>
    </SectionMessage>
  );

function AuditPanel({ gate, onChanged, version }) {
  const [period, setPeriod] = useState(PERIODS[2]);
  const [status, setStatus] = useState(null);
  const [rows, setRows] = useState([]);
  const [rowsLimit, setRowsLimit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [progress, setProgress] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [showHow, setShowHow] = useState(false);
  const [prices, setPrices] = useState({});
  const [savedPrices, setSavedPrices] = useState({});
  // Text boxes keep their own text (defaultValue); the page only listens.
  // Feeding the value back on every keystroke loses characters in UI Kit.
  const [pricesVersion, setPricesVersion] = useState(0);
  const [searchVersion, setSearchVersion] = useState(0);
  const [query, setQuery] = useState('');
  const [productFilter, setProductFilter] = useState(ALL_PRODUCTS);
  const [bandFilter, setBandFilter] = useState(ALL_BANDS);
  const [statusFilter, setStatusFilter] = useState(STATUS_FILTERS[0]);

  const refresh = useCallback(async () => {
    try {
      const res = await invoke('getStatus');
      setStatus(res);
      return res;
    } catch {
      return null;
    }
  }, []);

  const applyCosts = (costs) => {
    setSavedPrices(costs);
    setPrices(Object.fromEntries(Object.entries(costs).map(([k, v]) => [k, String(v)])));
    setPricesVersion((v) => v + 1);
  };

  useEffect(() => {
    refresh();
    invoke('getSettings')
      .then((res) => applyCosts(res?.settings?.seatCosts ?? {}))
      .catch(() => {});
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

  // The whole list loads at once, so search, filters and "select all" cover
  // every inactive user, not just one page.
  const loadAll = useCallback(async () => {
    try {
      const res = await invoke('getAllRows');
      setRows(res?.rows ?? []);
      setRowsLimit(res?.limit ?? null);
    } catch (err) {
      setMessage(`Could not load the list: ${err?.message ?? 'no response'}.`);
    }
  }, []);

  const generatedAt = report?.generatedAt;
  useEffect(() => {
    if (generatedAt && !running) {
      setSelected(new Set());
      loadAll();
    }
  }, [generatedAt, running, loadAll]);

  // An undo in the History tab changes what this list should show.
  const [seenVersion, setSeenVersion] = useState(version);
  useEffect(() => {
    if (version === seenVersion) return;
    setSeenVersion(version);
    if (generatedAt && !running) loadAll();
  }, [version, seenVersion, generatedAt, running, loadAll]);

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

  const savePrices = async () => {
    try {
      const res = await invoke('saveSettings', { seatCosts: prices });
      applyCosts(res?.settings?.seatCosts ?? {});
    } catch {
      setMessage('Could not save the seat prices. Try again.');
    }
  };

  const toggle = (accountId, on) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(accountId);
      else next.delete(accountId);
      return next;
    });

  const protect = async (u, on) => {
    try {
      const res = await invoke('setProtected', { accountId: u.accountId, protected: on });
      if (!res?.ok) throw new Error(res?.error);
      toggle(u.accountId, false);
      setRows((prev) => prev.map((r) => (r.accountId === u.accountId ? { ...r, isProtected: on } : r)));
    } catch {
      setMessage('Could not update the protected list. Try again.');
    }
  };

  const products = report?.products ?? [];
  const liveCosts = useMemo(() => normaliseSeatCosts(prices), [prices]);
  const pricesDirty = JSON.stringify(liveCosts) !== JSON.stringify(normaliseSeatCosts(savedPrices));
  const saving = report ? yearlySaving(report.dormantByProduct, liveCosts) : null;

  const productOptions = useMemo(
    () => [ALL_PRODUCTS, ...products.map((p) => ({ label: p.name, value: p.name }))],
    [products]
  );
  const bands = useMemo(() => [ALL_BANDS, ...bandOptions(rows)], [rows]);
  const visible = useMemo(
    () =>
      filterRows(rows, { query, product: productFilter.value || null, band: bandFilter.value || null }).filter(
        (u) => !statusFilter.value || statusGroup(u) === statusFilter.value
      ),
    [rows, query, productFilter, bandFilter, statusFilter]
  );
  const filtering = Boolean(query || productFilter.value || bandFilter.value || statusFilter.value);
  const readyVisible = visible.filter(canSelect);
  const chosen = useMemo(() => rows.filter((u) => selected.has(u.accountId)), [rows, selected]);
  const chosenSaving = useMemo(() => {
    const perProduct = {};
    for (const u of chosen) for (const p of u.freedProducts ?? []) perProduct[p] = (perProduct[p] ?? 0) + 1;
    return yearlySaving(perProduct, liveCosts);
  }, [chosen, liveCosts]);
  const scan = scanProgress(state);
  const hasEmails = rows.some((r) => r.email);
  const scanAgeDays = report?.generatedAt ? Math.floor((Date.now() - Date.parse(report.generatedAt)) / 86_400_000) : 0;
  const totalSeats = Object.values(report?.dormantByProduct ?? {}).reduce((a, b) => a + b, 0);

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
      setProgress({ done: i, total: ids.length });
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
    await loadAll();
    onChanged?.();
  };

  return (
    <Stack space="space.200">
      <HowItWorks compact={Boolean(report) && !showHow} onToggle={report ? () => setShowHow((v) => !v) : null} />

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
        <Stack space="space.075">
          <ProgressBar ariaLabel="Scan progress" value={scan.value} isIndeterminate={scan.indeterminate} />
          <Text>{phaseText(state)}. You can leave this page — the scan continues.</Text>
        </Stack>
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
        <Stack space="space.075">
          <ProgressBar ariaLabel="Reclaim progress" value={progress.total ? progress.done / progress.total : 0} />
          <Text>
            Reclaiming seats — {Math.min(progress.done + BATCH, progress.total)} of {progress.total} users. Keep this
            page open.
          </Text>
        </Stack>
      )}

      {outcome && <Outcome outcome={outcome} />}

      {report && (
        <Stack space="space.150">
          <Stack space="space.050">
            <Heading as="h2" size="medium">
              {report.dormantCount} inactive {report.dormantCount === 1 ? 'user' : 'users'}
              {totalSeats !== report.dormantCount ? ` holding ${totalSeats} seats` : ''}
              {saving !== null ? ` · about ${fmtMoney(saving)} a year` : ''}
            </Heading>
            <Text>
              {report.totalUsers} licensed · {report.activeUsers} active · {report.days}-day window · scanned{' '}
              {fmtDate(report.generatedAt)}
            </Text>
            {report.dormantCount > 0 && saving === null && (
              <Text>Enter the yearly price of a seat below to see what these seats cost.</Text>
            )}
          </Stack>

          {products.length > 0 && (
            <Stack space="space.100">
              <DynamicTable
                head={{
                  cells: [
                    { key: 'product', content: 'Product' },
                    { key: 'seats', content: 'Seats at scan time' },
                    { key: 'limit', content: 'Plan limit' },
                    { key: 'inactive', content: 'Inactive' },
                    { key: 'price', content: 'Yearly price of one seat' },
                    { key: 'cost', content: 'Inactive seats cost' },
                  ],
                }}
                rows={products.map((p) => {
                  const inactive = report.dormantByProduct?.[p.name] ?? 0;
                  const price = liveCosts[p.name];
                  return {
                    key: p.key,
                    cells: [
                      { key: `name-${p.name}`, content: p.name },
                      { key: `seats-${p.userCount ?? 0}`, content: p.userCount ?? '—' },
                      {
                        key: `limit-${p.numberOfSeats ?? 0}`,
                        content: p.hasUnlimitedSeats ? 'Unlimited' : (p.numberOfSeats ?? '—'),
                      },
                      { key: `inactive-${inactive}`, content: inactive },
                      {
                        key: `price-${p.name}`,
                        content: (
                          <Box xcss={{ maxWidth: '140px' }}>
                            <Textfield
                              key={`price-${p.key}-${pricesVersion}`}
                              id={`price-${p.key}`}
                              name={`price-${p.key}`}
                              isCompact
                              defaultValue={prices[p.name] ?? ''}
                              placeholder="e.g. 100"
                              onChange={(e) => {
                                const value = e?.target?.value ?? '';
                                setPrices((prev) => ({ ...prev, [p.name]: value }));
                              }}
                            />
                          </Box>
                        ),
                      },
                      {
                        key: `cost-${p.name}`,
                        content: price && inactive ? `${fmtMoney(price * inactive)} a year` : '—',
                      },
                    ],
                  };
                })}
              />
              <Inline space="space.100" alignBlock="center">
                <Button onClick={savePrices} isDisabled={!pricesDirty}>
                  Save prices
                </Button>
                <Text>
                  {pricesDirty
                    ? 'Prices are saved for this site, so the cost shows on every visit.'
                    : 'Use what one seat costs you per year, in your billing currency.'}
                </Text>
              </Inline>
            </Stack>
          )}

          {(report.warnings ?? []).map((w) => (
            <SectionMessage key={w} appearance="warning">
              <Text>{w}</Text>
            </SectionMessage>
          ))}

          {scanAgeDays >= 7 && !running && (
            <SectionMessage appearance="warning">
              <Text>
                This list is {scanAgeDays} days old. Run a new scan before reclaiming. Anyone active since the scan is
                skipped at reclaim time, but the list itself is out of date.
              </Text>
            </SectionMessage>
          )}

          {report.dormantCount === 0 ? (
            <SectionMessage appearance="success" title="No inactive users">
              <Text>
                Every one of the {report.totalUsers} licensed users was active in the last {report.days} days.
              </Text>
            </SectionMessage>
          ) : (
            <Stack space="space.150">
              <Inline space="space.100" alignBlock="end" shouldWrap>
                <Box xcss={{ minWidth: '220px' }}>
                  <Label labelFor="search">Search</Label>
                  <Textfield
                    key={`search-${searchVersion}`}
                    id="search"
                    name="search"
                    defaultValue={query}
                    placeholder="Name or email"
                    onChange={(e) => setQuery(e?.target?.value ?? '')}
                  />
                </Box>
                {products.length > 1 && (
                  <Box xcss={{ minWidth: '190px' }}>
                    <Label labelFor="product-filter">Product</Label>
                    <Select
                      id="product-filter"
                      options={productOptions}
                      value={productFilter}
                      onChange={(v) => setProductFilter(v ?? ALL_PRODUCTS)}
                    />
                  </Box>
                )}
                <Box xcss={{ minWidth: '180px' }}>
                  <Label labelFor="band-filter">Inactive for</Label>
                  <Select id="band-filter" options={bands} value={bandFilter} onChange={(v) => setBandFilter(v ?? ALL_BANDS)} />
                </Box>
                <Box xcss={{ minWidth: '180px' }}>
                  <Label labelFor="status-filter">Show</Label>
                  <Select
                    id="status-filter"
                    options={STATUS_FILTERS}
                    value={statusFilter}
                    onChange={(v) => setStatusFilter(v ?? STATUS_FILTERS[0])}
                  />
                </Box>
                {filtering && (
                  <Button
                    appearance="subtle"
                    onClick={() => {
                      setQuery('');
                      setSearchVersion((v) => v + 1);
                      setProductFilter(ALL_PRODUCTS);
                      setBandFilter(ALL_BANDS);
                      setStatusFilter(STATUS_FILTERS[0]);
                    }}
                  >
                    Clear filters
                  </Button>
                )}
              </Inline>

              <Inline space="space.100" alignBlock="center" shouldWrap>
                <Button
                  onClick={() => setSelected((prev) => new Set([...prev, ...readyVisible.map((u) => u.accountId)]))}
                  isDisabled={!readyVisible.length || !gate.allowed}
                >
                  Select all ready ({readyVisible.length})
                </Button>
                <Button appearance="subtle" onClick={() => setSelected(new Set())} isDisabled={!selected.size}>
                  Clear selection
                </Button>
                <Button
                  appearance="danger"
                  onClick={() => setConfirmOpen(true)}
                  isDisabled={!chosen.length || Boolean(progress) || !gate.allowed || (running && !stale)}
                >
                  {chosen.length
                    ? `Reclaim seats for ${chosen.length} ${chosen.length === 1 ? 'user' : 'users'}`
                    : 'Reclaim seats'}
                </Button>
                {chosenSaving !== null && <Text>About {fmtMoney(chosenSaving)} a year for the selected.</Text>}
              </Inline>
              <Text>
                Showing {visible.length} of {rows.length}
                {selected.size ? ` · ${selected.size} selected` : ''}
                {rowsLimit && rows.length >= rowsLimit && report.dormantCount > rows.length
                  ? ` (the first ${rowsLimit} of ${report.dormantCount})`
                  : ''}
              </Text>

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
                rows={visible.map((u) => {
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
                            onChange={() => toggle(u.accountId, !selected.has(u.accountId))}
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
                        content: (
                          <Lozenge appearance={String(u.bucket).startsWith('over-') ? 'removed' : 'moved'}>{u.label}</Lozenge>
                        ),
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
                emptyView={<Text>No inactive users match these filters.</Text>}
              />

              {!hasEmails && (
                <Text>Emails are hidden because those users' profile privacy settings don't share them with apps.</Text>
              )}
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
                  products and frees those seats. Their Atlassian account stays active. Before each change the app
                  checks live that the person is still inactive and reads their groups again; anyone who has used
                  Jira since the scan is skipped. You can undo any of it from the History tab.
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
        {done.length > 0 && changed.length === 0 && counts.length > 0 && (
          <Text>Atlassian's seat counts haven't changed yet. They usually update within a minute.</Text>
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
