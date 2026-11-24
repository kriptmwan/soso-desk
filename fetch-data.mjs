// SOSO Desk — live data fetcher (SoSoValue API -> data/snapshot.json).
// Run:  SOSO_API_KEY=<key> node fetch-data.mjs
// No key: exits 0 WITHOUT touching the snapshot (the checked-in sample stays).
//
// MIXED-SOURCE DESIGN (honest fallback, no silent mixing):
// Each section (market / etf / news) is fetched live independently. A section
// that fails keeps the PREVIOUS snapshot's data for that section, relabelled
// "stale" (was live) or "sample" (was sample), with its original fetched_at
// preserved. The dashboard shows a per-section LIVE / SAMPLE / STALE / FAILED
// badge, so a reader can always tell which numbers are fresh.
//
// KNOWN ENVIRONMENTAL LIMIT (verified 24 Nov 2026):
// From this VM, /news and /currencies return code 0, but /market-snapshot,
// /etfs and /news/hot return a Cloudflare 403 edge block even with a valid
// key (not an auth failure). The GitHub Actions refresh runs the same script
// from GitHub runners, whose egress IPs may pass Cloudflare where this VM
// does not. The script keeps trying the real endpoints on every run, so the
// snapshot goes live automatically if/when the block lifts.
//
// Docs: https://sosovalue-1.gitbook.io/sosovalue-api-doc
//   GET /currencies                       -> [{currency_id, symbol, name}]
//   GET /currencies/{id}/market-snapshot  -> {price, change_pct_24h, ...}
//   GET /etfs?symbol=BTC&country_code=US -> [{ticker, name, exchange}]
//   GET /etfs/{ticker}/market-snapshot    -> {net_inflow, cum_inflow, ...}
//   GET /news?limit=20&language=en       -> {list: [{id, title, ...}]}
//   (GET /news/hot is the trending feed but is edge-blocked from this VM;
//    /news is the same feed family and works, so it is used here.)
// All responses are wrapped: {code: 0, message: "success", data: ...}
// Free tier: 100k req/month, 20 req/min (we make ~18 per run, sequential).

import { writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { scoreNewsSentiment, analyzeDesk, summarizeDesk, appendHistoryEntry } from './signal-engine.js';

const BASE = 'https://openapi.sosovalue.com/openapi/v1';
const OUT = new URL('./data/snapshot.json', import.meta.url);
const KEY = process.env.SOSO_API_KEY || '';

const TARGET_CURRENCIES = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE'];
const PREFERRED_NAMES = {
  BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana',
  BNB: 'Binance Coin', XRP: 'XRP', DOGE: 'Dogecoin',
};
const ETF_TARGETS = [
  { symbol: 'BTC', take: 3 },
  { symbol: 'ETH', take: 2 },
  { symbol: 'SOL', take: 2 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path) {
  const url = `${BASE}${path}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { 'x-soso-api-key': KEY, 'User-Agent': 'soso-desk/1.0 (+https://github.com/kriptmwan/soso-desk)' },
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      throw new Error(`network error on ${path}: ${e.message}`);
    }
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* Cloudflare HTML page */ }
    if (res.status === 403 || (body === null && /cloudflare/i.test(text))) {
      throw new Error(`Cloudflare 403 edge block on ${path} (key is valid — network-level block)`);
    }
    if (res.status === 429 || (body && body.code === 42901)) {
      if (attempt === 1) { console.log(`  429 on ${path}, retrying in 15s…`); await sleep(15000); continue; }
      throw new Error(`rate-limited (429) on ${path}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
    if (!body || body.code !== 0) {
      throw new Error(`API code ${body ? body.code : 'n/a'} (${body ? body.message : 'no body'}) on ${path}`);
    }
    return body.data;
  }
  throw new Error(`unreachable: ${path}`);
}

function gitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return 'n/a'; }
}

function loadPrevious() {
  try {
    if (!existsSync(OUT)) return null;
    return JSON.parse(readFileSync(OUT, 'utf8'));
  } catch { return null; }
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`SOSO Desk fetch — ${startedAt}`);
  if (!KEY) {
    console.log('NO_KEY: SOSO_API_KEY is not set. Keeping the checked-in sample snapshot.');
    console.log('Get a free key at https://sosovalue.com/developer/dashboard, then re-run with SOSO_API_KEY=<key>.');
    return;
  }
  const prev = loadPrevious();
  const prevSection = (name) => (prev && prev.sections && prev.sections[name]) || null;
  const prevItems = (name) => (prev && Array.isArray(prev[name]) ? prev[name] : []);

  const sections = {};
  const market = [];
  const etf = [];
  let news = [];
  let newsSentiment = null;

  // 1. Currencies: resolve symbol -> currency_id (name-preferred, so the
  //    Dogecoin DOGE wins over same-symbol impostors), then snapshot each.
  try {
    const list = await api('/currencies');
    const bySymbol = new Map();
    for (const c of list || []) {
      const sym = String(c.symbol || '').toUpperCase();
      if (!TARGET_CURRENCIES.includes(sym)) continue;
      const cur = bySymbol.get(sym);
      if (!cur || c.name === PREFERRED_NAMES[sym]) bySymbol.set(sym, c);
    }
    const missing = TARGET_CURRENCIES.filter((s) => !bySymbol.has(s));
    const errors = [];
    for (const sym of TARGET_CURRENCIES) {
      const cur = bySymbol.get(sym);
      if (!cur) continue;
      await sleep(1000);
      try {
        const snap = await api(`/currencies/${cur.currency_id}/market-snapshot`);
        market.push({
          symbol: sym, name: cur.name, currency_id: cur.currency_id,
          price: snap.price, change_pct_24h: snap.change_pct_24h,
          turnover_24h: snap.turnover_24h, turnover_rate: snap.turnover_rate,
          high_24h: snap.high_24h, low_24h: snap.low_24h,
          marketcap: snap.marketcap, fdv: snap.fdv,
          marketcap_rank: snap.marketcap_rank, ath: snap.ath,
          down_from_ath: snap.down_from_ath ?? '', cycle_low: snap.cycle_low,
          up_from_cycle_low: snap.up_from_cycle_low ?? '',
        });
      } catch (e) { errors.push(`${sym}: ${e.message}`); }
    }
    if (market.length > 0) {
      sections.market = {
        status: market.length === TARGET_CURRENCIES.length && missing.length === 0 ? 'ok' : 'partial',
        source: 'live', fetched_at: new Date().toISOString(),
        error: [...missing.map((s) => `symbol ${s} not in /currencies`), ...errors].join('; ') || null,
      };
    } else {
      throw new Error(errors.join('; ') || 'no market snapshots returned');
    }
  } catch (e) {
    const p = prevSection('market');
    sections.market = {
      status: prevItems('market').length > 0 ? (p && p.source === 'live' ? 'stale' : 'sample') : 'failed',
      source: prevItems('market').length > 0 ? (p ? p.source : 'sample') : 'none',
      fetched_at: p ? p.fetched_at : null,
      error: `live fetch failed: ${e.message}`,
    };
    market.push(...prevItems('market'));
  }

  // 2. ETFs: list tickers per asset, then snapshot the largest few.
  try {
    const errors = [];
    for (const { symbol, take } of ETF_TARGETS) {
      await sleep(1000);
      let tickers;
      try {
        tickers = await api(`/etfs?symbol=${symbol}&country_code=US`);
      } catch (e) { errors.push(`${symbol} list: ${e.message}`); continue; }
      for (const t of (tickers || []).slice(0, take)) {
        await sleep(1000);
        try {
          const snap = await api(`/etfs/${t.ticker}/market-snapshot`);
          etf.push({
            asset: symbol, ticker: t.ticker, name: t.name, date: snap.date,
            sponsor_fee: snap.sponsor_fee, net_inflow: snap.net_inflow,
            cum_inflow: snap.cum_inflow, net_assets: snap.net_assets,
            mkt_price: snap.mkt_price, prem_dsc: snap.prem_dsc,
            value_traded: snap.value_traded, volume: snap.volume,
          });
        } catch (e) { errors.push(`${t.ticker}: ${e.message}`); }
      }
    }
    if (etf.length > 0) {
      sections.etf = {
        status: etf.length >= 5 ? 'ok' : 'partial',
        source: 'live', fetched_at: new Date().toISOString(),
        error: errors.join('; ') || null,
      };
    } else {
      throw new Error(errors.join('; ') || 'no ETF snapshots returned');
    }
  } catch (e) {
    const p = prevSection('etf');
    sections.etf = {
      status: prevItems('etf').length > 0 ? (p && p.source === 'live' ? 'stale' : 'sample') : 'failed',
      source: prevItems('etf').length > 0 ? (p ? p.source : 'sample') : 'none',
      fetched_at: p ? p.fetched_at : null,
      error: `live fetch failed: ${e.message}`,
    };
    etf.push(...prevItems('etf'));
  }

  // 3. News: /news works live from this VM (unlike /news/hot, which is
  //    edge-blocked here). Same feed family; sentiment runs over titles.
  try {
    await sleep(1000);
    const data = await api('/news?limit=20&language=en');
    news = (data.list || []).map((n) => ({
      id: String(n.id), title: n.title, source_link: n.source_link,
      original_link: n.original_link || null, release_time: Number(n.release_time) || null,
    }));
    newsSentiment = scoreNewsSentiment(news.map((n) => n.title));
    sections.news = {
      status: news.length > 0 ? 'ok' : 'failed',
      source: 'live', fetched_at: new Date().toISOString(), error: null,
    };
  } catch (e) {
    const p = prevSection('news');
    news = prevItems('news');
    newsSentiment = prev ? prev.news_sentiment : null;
    sections.news = {
      status: news.length > 0 ? (p && p.source === 'live' ? 'stale' : 'sample') : 'failed',
      source: news.length > 0 ? (p ? p.source : 'sample') : 'none',
      fetched_at: p ? p.fetched_at : null,
      error: `live fetch failed: ${e.message}`,
    };
  }

  const liveCount = Object.values(sections).filter((s) => s.source === 'live').length;
  const topSource = liveCount === 3 ? 'live' : liveCount === 0 ? (prev ? prev.source : 'sample') : 'mixed';
  console.log('sections:', JSON.stringify(sections));

  const snapshot = {
    schema_version: 1,
    source: topSource,
    fetched_at: new Date().toISOString(),
    fetch_commit: gitCommit(),
    generator: 'fetch-data.mjs (SoSoValue API)',
    sections,
    market,
    etf,
    news,
    news_sentiment: newsSentiment || { score: 0, bullish: 0, bearish: 0, contested: 0, total: 0, method: '' },
  };
  const tmp = `${OUT.pathname}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
  renameSync(tmp, OUT.pathname);
  console.log(`WROTE ${OUT.pathname} (source=${topSource}) — market ${market.length} [${sections.market.status}], etf ${etf.length} [${sections.etf.status}], news ${news.length} [${sections.news.status}]`);

  // Append this run to the signal-history log (the desk's track record).
  try {
    const logPath = new URL('./data/signals-log.json', import.meta.url);
    let log = [];
    try { log = JSON.parse(readFileSync(logPath, 'utf8')); } catch { /* first run */ }
    const entry = summarizeDesk(analyzeDesk(snapshot, 'balanced'));
    log = appendHistoryEntry(log, entry, 30);
    const logTmp = `${logPath.pathname}.tmp`;
    writeFileSync(logTmp, `${JSON.stringify(log, null, 2)}\n`);
    renameSync(logTmp, logPath.pathname);
    console.log(`WROTE ${logPath.pathname} — ${log.length} entries (latest: ${entry.regime})`);
  } catch (e) {
    console.log(`history log skipped: ${e.message}`);
  }
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
