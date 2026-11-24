// SOSO Desk — dashboard app (browser, ES module).
// Loads data/snapshot.json, runs the shared signal engine, renders everything.
// No keys, no network calls to SoSoValue from the browser: the page only
// reads the snapshot the Actions pipeline committed.
import { analyzeDesk, tradeTicket } from './signal-engine.js';

const REPO = 'kriptmwan/soso-desk';
const STALE_MS = 24 * 3600 * 1000;

const $ = (id) => document.getElementById(id);
const fmtUsd = (n) => {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  const abs = Math.abs(v);
  if (abs >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
};
const fmtPrice = (n) => {
  if (n === null || n === undefined) return '—';
  const v = Number(n);
  return v >= 1000 ? `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
    : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;
};
const fmtPct = (n) => {
  if (n === null || n === undefined) return '—';
  const v = Number(n);
  return `<span class="${v >= 0 ? 'pos' : 'neg'}">${v >= 0 ? '+' : ''}${v.toFixed(2)}%</span>`;
};
const fmtTime = (iso) => {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let snap = null;
let profile = 'balanced';

function sectionBadge(name) {
  const s = snap.sections && snap.sections[name];
  if (!s) return { cls: 'failed', label: 'FAILED' };
  const age = s.fetched_at ? Date.now() - new Date(s.fetched_at).getTime() : Infinity;
  if (s.source === 'live' && age > STALE_MS) return { cls: 'stale', label: 'STALE' };
  if (s.status === 'ok' || s.status === 'partial') return { cls: s.source === 'live' ? 'live' : 'sample', label: s.source === 'live' ? 'LIVE' : 'SAMPLE' };
  if (s.status === 'stale') return { cls: 'stale', label: 'STALE' };
  if (s.status === 'sample') return { cls: 'sample', label: 'SAMPLE' };
  return { cls: 'failed', label: 'FAILED' };
}

function renderHeader() {
  const top = snap.source || 'sample';
  const age = snap.fetched_at ? Date.now() - new Date(snap.fetched_at).getTime() : Infinity;
  const stale = top === 'live' && age > STALE_MS;
  const cls = stale ? 'stale' : top === 'live' ? 'live' : top === 'mixed' ? 'mixed' : 'sample';
  const label = stale ? 'STALE' : top.toUpperCase();
  $('badges').innerHTML =
    `<span class="badge ${cls}">${label} DATA</span>` +
    ['market', 'etf', 'news'].map((n) => {
      const b = sectionBadge(n);
      return `<span class="badge ${b.cls}">${n.toUpperCase()}: ${b.label}</span>`;
    }).join('');
  $('dataMeta').textContent =
    `Snapshot fetched ${fmtTime(snap.fetched_at)} · generator: ${snap.generator || 'n/a'} · fetch commit: ${snap.fetch_commit || 'n/a'} · schema v${snap.schema_version || 1}`;
  $('refreshBtn').href = `https://github.com/${REPO}/actions/workflows/refresh-snapshot.yml`;

  const warn = $('sampleWarn');
  if (top !== 'live') {
    warn.classList.remove('hidden');
    warn.innerHTML = top === 'sample'
      ? '<b>Sample data.</b> This snapshot uses illustrative values so the demo works before live data lands. Every number is labelled SAMPLE — nothing here is presented as a real market quote. Run the Actions refresh (button above) once the repo secret is set for live data.'
      : '<b>Mixed data.</b> Some sections are live and some are sample/stale (per-section badges above). The fetcher retries the blocked endpoints on every run; see the footer for why.';
  } else if (stale) {
    warn.classList.remove('hidden');
    warn.textContent = 'Live snapshot is older than 24h (STALE). The scheduled refresh may have failed — check the Actions run log.';
  } else {
    warn.classList.add('hidden');
  }
}

function whatIfOverrides() {
  const etfMode = $('whatifEtf').value;
  const newsMode = $('whatifNews').value;
  if (etfMode === 'as-is' && newsMode === 'as-is') return {};
  const out = {};
  for (const m of snap.market || []) {
    const o = {};
    if (etfMode !== 'as-is') {
      const total = (snap.etf || []).filter((e) => e.asset === m.symbol)
        .reduce((s, e) => s + (Number(e.net_inflow) || 0), 0);
      o.etfFlowUsd = etfMode === 'zero' ? 0 : -total;
    }
    if (newsMode !== 'as-is') o.newsScore = newsMode === 'neutral' ? 0 : -0.6;
    out[m.symbol] = o;
  }
  return out;
}

function renderDesk() {
  const desk = analyzeDesk(snap, profile, whatIfOverrides());
  $('regime').innerHTML = `${esc(desk.regime)}<small>Regime score ${desk.regimeScore} / 100 · profile: ${esc(desk.profile)} · ${desk.whatIf ? 'WHAT-IF active — signals recomputed from your overrides' : 'computed from the snapshot above'}</small>`;

  $('signalCards').innerHTML = desk.signals.map((s) => {
    const w = Math.min(100, Math.abs(s.strength));
    const math = [
      `ETF flows   ${s.components.etf >= 0 ? '+' : ''}${s.components.etf} × 0.50 = ${s.contributions.etf >= 0 ? '+' : ''}${s.contributions.etf}`,
      `Market 24h  ${s.components.market >= 0 ? '+' : ''}${s.components.market} × 0.30 = ${s.contributions.market >= 0 ? '+' : ''}${s.contributions.market}`,
      `News        ${s.components.news >= 0 ? '+' : ''}${s.components.news} × 0.20 = ${s.contributions.news >= 0 ? '+' : ''}${s.contributions.news}`,
      `TOTAL STRENGTH = ${s.strength >= 0 ? '+' : ''}${s.strength} / 100`,
    ].join('\n');
    return `<div class="card">
      <h3>${esc(s.asset)}</h3>
      <div class="dir ${s.direction}">${s.direction} · ${s.strength >= 0 ? '+' : ''}${s.strength}/100</div>
      <div class="bar${s.strength < 0 ? ' neg' : ''}"><i style="width:${w}%"></i></div>
      <div class="math">${esc(math)}</div>
      <div class="cap">Confirmations: <b>${s.confirmations.length ? s.confirmations.join(' + ') : 'none'}</b> · Confidence: <b>${s.confidence}</b><br>Position cap: <b>${s.capPct}% of portfolio</b> (${esc(s.profile)})</div>
      <ul>${s.explanation.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
      <p class="cap">Risks: ${s.risks.map(esc).join(' ')}</p>
      <p><button class="btn" data-ticket="${esc(s.asset)}">Copy trade ticket</button></p>
    </div>`;
  }).join('');

  document.querySelectorAll('[data-ticket]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const sig = desk.signals.find((x) => x.asset === btn.dataset.ticket);
      const text = tradeTicket(sig, snap);
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copied ✓';
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        btn.textContent = 'Copied ✓';
      }
      setTimeout(() => { btn.textContent = 'Copy trade ticket'; }, 2000);
    });
  });
}

function renderTables() {
  const mb = sectionBadge('market');
  const eb = sectionBadge('etf');
  const nb = sectionBadge('news');
  $('marketBadge').className = `badge ${mb.cls}`;
  $('marketBadge').textContent = mb.label;
  $('etfBadge').className = `badge ${eb.cls}`;
  $('etfBadge').textContent = eb.label;
  $('newsBadge').className = `badge ${nb.cls}`;
  $('newsBadge').textContent = nb.label;

  $('marketTable').querySelector('tbody').innerHTML = (snap.market || []).map((m) => `<tr>
    <td><b>${esc(m.symbol)}</b> <span style="color:var(--muted)">${esc(m.name || '')}</span></td>
    <td class="num">${fmtPrice(m.price)}</td><td class="num">${fmtPct(m.change_pct_24h)}</td>
    <td class="num">${fmtUsd(m.turnover_24h)}</td><td class="num">${fmtUsd(m.marketcap)}</td>
    <td class="num">${m.marketcap_rank ?? '—'}</td></tr>`).join('');

  const maxFlow = Math.max(1, ...(snap.etf || []).map((e) => Math.abs(Number(e.net_inflow) || 0)));
  $('etfTable').querySelector('tbody').innerHTML = (snap.etf || []).map((e) => {
    const flow = Number(e.net_inflow) || 0;
    return `<tr>
    <td><b>${esc(e.ticker)}</b> <span style="color:var(--muted)">${esc(e.name || '')} · ${esc(e.asset || '')}</span>
      <div class="flowbar"><i style="width:${Math.round((Math.abs(flow) / maxFlow) * 100)}%;${flow < 0 ? 'background:var(--red)' : ''}"></i></div></td>
    <td class="num ${flow >= 0 ? 'pos' : 'neg'}">${flow >= 0 ? '+' : ''}${fmtUsd(flow)}</td>
    <td class="num">${fmtUsd(e.cum_inflow)}</td><td class="num">${fmtUsd(e.net_assets)}</td>
    <td class="num">${fmtPrice(e.mkt_price)}</td><td class="num">${e.prem_dsc === null || e.prem_dsc === undefined ? '—' : `${(Number(e.prem_dsc) * 100).toFixed(2)}%`}</td></tr>`;
  }).join('');

  const ns = snap.news_sentiment || {};
  $('sentimentLine').innerHTML = ns.total
    ? `News sentiment <b>${Number(ns.score) >= 0 ? '+' : ''}${Number(ns.score).toFixed(2)}</b> — ${ns.bullish} bullish / ${ns.bearish} bearish / ${ns.contested || 0} contested of ${ns.total} headlines. <span style="color:var(--muted)">${esc(ns.method || '')}</span>`
    : 'No headlines in this snapshot.';
  $('newsList').innerHTML = (snap.news || []).map((n) => `<li>
    <a href="${esc(n.source_link || n.original_link || '#')}" target="_blank" rel="noopener">${esc(n.title)}</a>
    <time>${n.release_time ? fmtTime(new Date(Number(n.release_time)).toISOString()) : ''}${n.id ? ` · #${esc(n.id)}` : ''}</time>
  </li>`).join('');

  const prov = [];
  for (const name of ['market', 'etf', 'news']) {
    const s = snap.sections && snap.sections[name];
    if (!s) continue;
    prov.push(`<b>${name}</b>: ${s.source || s.status} · fetched ${fmtTime(s.fetched_at)}${s.error ? ` · note: ${esc(s.error)}` : ''}`);
  }
  $('provenance').innerHTML = prov.join('<br>');
}

function loadPrefs() {
  try {
    if (typeof localStorage === 'undefined') return;
    const p = localStorage.getItem('soso-desk-profile');
    if (p && ['conservative', 'balanced', 'aggressive'].includes(p)) {
      profile = p;
      document.querySelectorAll('.profile').forEach((b) => b.classList.toggle('active', b.dataset.profile === p));
    }
    const w = JSON.parse(localStorage.getItem('soso-desk-whatif') || '{}');
    if (w.etf) $('whatifEtf').value = w.etf;
    if (w.news) $('whatifNews').value = w.news;
  } catch { /* private mode etc. — prefs are a nicety, not load-bearing */ }
}

function savePrefs() {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem('soso-desk-profile', profile);
    localStorage.setItem('soso-desk-whatif', JSON.stringify({ etf: $('whatifEtf').value, news: $('whatifNews').value }));
  } catch { /* ignore */ }
}

async function init() {
  try {
    const res = await fetch('./data/snapshot.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`snapshot.json HTTP ${res.status}`);
    snap = await res.json();
  } catch (e) {
    document.querySelector('main').innerHTML = `<section><h2>Could not load data</h2><p>${esc(e.message)} — the snapshot file is missing. See the README for setup.</p></section>`;
    return;
  }
  renderHeader();
  loadPrefs();
  renderDesk();
  renderTables();

  document.querySelectorAll('.profile').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.profile').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      profile = btn.dataset.profile;
      savePrefs();
      renderDesk();
    });
  });
  $('whatifEtf').addEventListener('change', () => { savePrefs(); renderDesk(); });
  $('whatifNews').addEventListener('change', () => { savePrefs(); renderDesk(); });
  $('resetWhatif').addEventListener('click', () => {
    $('whatifEtf').value = 'as-is';
    $('whatifNews').value = 'as-is';
    savePrefs();
    renderDesk();
  });
}

init();
