import { invoke } from '@forge/bridge';

/**
 * The one thing UI Kit cannot do is hand the browser a file. This tiny
 * Custom UI resource lives inside a UI Kit <Frame> purely to turn the report
 * into a download. It talks to the same resolvers as the main page.
 */

const $ = (id) => document.getElementById(id);

const csvOf = (rows) =>
  ['Display name,Email,Products,Last activity,Can reclaim,Would free,Reason,Account ID']
    .concat(
      rows.map((r) =>
        [
          r.displayName,
          r.email ?? '',
          (r.products ?? []).join(' / '),
          r.label ?? '',
          r.lastAction?.status === 'reclaimed' ? 'Already reclaimed' : r.reclaimable && !r.isProtected ? 'Yes' : 'No',
          (r.freedProducts ?? []).join(' / '),
          r.reason ?? '',
          r.accountId,
        ]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(',')
      )
    )
    .join('\r\n');

const today = () => new Date().toISOString().slice(0, 10);

function offerDownload(text, filename) {
  // ﻿: the BOM makes Excel open the file as UTF-8 without an import wizard.
  const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function refreshCount() {
  try {
    const res = await invoke('getStatus');
    const n = res?.report?.dormantCount ?? 0;
    $('download').textContent = n ? `Download CSV (${n} inactive users)` : 'Download CSV';
    $('download').disabled = !n;
  } catch {
    $('status').textContent = 'Could not read the report.';
  }
}

async function download() {
  const btn = $('download');
  btn.disabled = true;
  $('status').textContent = 'Preparing…';
  try {
    const res = await invoke('getAllRows');
    if (res?.forbidden) throw new Error(res.error);
    const rows = res?.rows ?? [];
    const text = csvOf(rows);
    offerDownload(text, `seat-reclaim-${today()}.csv`);
    $('status').textContent =
      `${rows.length} rows` +
      (res?.limit && rows.length >= res.limit ? ` (capped at ${res.limit})` : '') +
      '. If nothing downloaded, use “Copy CSV” instead.';
    $('copy').hidden = false;
    $('copy').onclick = async () => {
      try {
        await navigator.clipboard.writeText(text);
        $('status').textContent = 'Copied to the clipboard.';
      } catch {
        const ta = $('fallback');
        ta.hidden = false;
        ta.value = text;
        ta.focus();
        ta.select();
        $('status').textContent = 'Select the text below and copy it.';
      }
    };
  } catch (err) {
    $('status').textContent = `Could not build the export: ${err?.message ?? 'no response'}.`;
  } finally {
    btn.disabled = false;
  }
}

$('download').addEventListener('click', download);
refreshCount();
