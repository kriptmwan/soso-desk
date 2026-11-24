// SOSO Desk — signal engine tests. Run: node test-engine.mjs
// No network, no key. Exits non-zero on any failure.
import { analyzeDesk, buildSignal, scoreNewsSentiment, tradeTicket, summarizeDesk, appendHistoryEntry } from './signal-engine.js';
import { readFileSync } from 'node:fs';

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}
const approx = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

// --- Fixture: aligned bullish inputs ---------------------------------------
function bullishSnap() {
  return {
    source: 'sample', fetched_at: '2026-11-24T00:00:00Z',
    market: [
      { symbol: 'BTC', price: 87000, change_pct_24h: 2.0, down_from_ath: '-30%' },
      { symbol: 'ETH', price: 2900, change_pct_24h: 3.0, down_from_ath: '-40%' },
    ],
    etf: [
      { asset: 'BTC', ticker: 'IBIT', net_inflow: 400000000, prem_dsc: 0 },
      { asset: 'BTC', ticker: 'FBTC', net_inflow: 100000000, prem_dsc: 0 },
      { asset: 'ETH', ticker: 'ETHA', net_inflow: 100000000, prem_dsc: 0 },
    ],
    news_sentiment: { score: 0.6, bullish: 8, bearish: 2, total: 10 },
  };
}

console.log('== sentiment lexicon ==');
{
  const s = scoreNewsSentiment([
    'Bitcoin ETFs see record inflows as rally continues',
    'Ethereum surges past resistance on strong buying',
    'Crypto market crashes as hack fears spread',
  ]);
  check('2 bull / 1 bear -> score +0.33', approx(s.score, 0.33), JSON.stringify(s));
  check('contested title ignored', scoreNewsSentiment(['Bitcoin rally faces crash fears']).total === 1
    && scoreNewsSentiment(['Bitcoin rally faces crash fears']).bullish === 0);
  check('empty titles -> 0', scoreNewsSentiment([]).score === 0);
}

console.log('== aligned bullish -> ACCUMULATE ==');
{
  const snap = bullishSnap();
  const sig = buildSignal('BTC', snap, 'balanced');
  // ETF: +500M -> +100 * 0.5 = +50; market: +2% -> +40 * 0.3 = +12; news: +60 * 0.2 = +12 => 74
  check('strength ~74', approx(sig.strength, 74, 0.5), `got ${sig.strength}`);
  check('direction ACCUMULATE', sig.direction === 'ACCUMULATE');
  check('3 confirmations', sig.confirmations.length === 3, JSON.stringify(sig.confirmations));
  check('confidence high', sig.confidence === 'high');
  check('cap = 5% * 0.74 = 3.7', approx(sig.capPct, 3.7, 0.05), `got ${sig.capPct}`);
  check('explanation cites numbers', sig.explanation.join(' ').includes('$500.0M'));
  const ticket = tradeTicket(sig, snap);
  check('ticket has call + size', ticket.includes('ACCUMULATE') && ticket.includes('3.7%'));
  check('ticket watermarked when source is sample', ticket.includes('SAMPLE/STALE DATA'));
  check('ticket clean when source is live', !tradeTicket(sig, { ...snap, source: 'live' }).includes('SAMPLE/STALE DATA'));
}

console.log('== conflicting inputs -> DIVERGENT, cap 0 ==');
{
  const snap = bullishSnap();
  snap.etf = [
    { asset: 'BTC', ticker: 'IBIT', net_inflow: 500000000, prem_dsc: 0 },
  ];
  snap.market = [{ symbol: 'BTC', price: 87000, change_pct_24h: -4.5, down_from_ath: '-30%' }];
  snap.news_sentiment = { score: -0.5, bullish: 2, bearish: 6, total: 8 };
  const sig = buildSignal('BTC', snap, 'aggressive');
  // ETF +50, market -27, news -10 => +13 total, but market+news disagree -> DIVERGENT
  check('direction DIVERGENT', sig.direction === 'DIVERGENT', `got ${sig.direction} strength ${sig.strength}`);
  check('cap 0 on divergent', sig.capPct === 0);
  check('disagreeing lists market+news', sig.disagreeing.includes('market') && sig.disagreeing.includes('news'));
}

console.log('== flat inputs -> WAIT ==');
{
  const snap = bullishSnap();
  snap.market = [{ symbol: 'BTC', price: 87000, change_pct_24h: 0.1, down_from_ath: '-30%' }];
  snap.etf = [{ asset: 'BTC', ticker: 'IBIT', net_inflow: 10000000, prem_dsc: 0 }];
  snap.news_sentiment = { score: 0, bullish: 0, bearish: 0, total: 0 };
  const sig = buildSignal('BTC', snap, 'conservative');
  check('direction WAIT', sig.direction === 'WAIT', `got ${sig.direction}`);
  check('cap 0 on wait', sig.capPct === 0);
}

console.log('== profiles scale caps ==');
{
  const snap = bullishSnap();
  const c = buildSignal('BTC', snap, 'conservative');
  const a = buildSignal('BTC', snap, 'aggressive');
  check('conservative cap 1.5 (2% * 0.74)', approx(c.capPct, 1.5, 0.05), `got ${c.capPct}`);
  check('aggressive cap 7.4 (10% * 0.74)', approx(a.capPct, 7.4, 0.05), `got ${a.capPct}`);
}

console.log('== what-if override flips a signal ==');
{
  const snap = bullishSnap();
  const base = buildSignal('BTC', snap, 'balanced');
  const flipped = buildSignal('BTC', snap, 'balanced', { etfFlowUsd: -500000000 });
  check('what-if flips direction', flipped.direction !== base.direction, `${base.direction} -> ${flipped.direction}`);
  check('what-if strength negative', flipped.strength < 0, `got ${flipped.strength}`);
}

console.log('== no ETF data -> component neutral, still works ==');
{
  const snap = bullishSnap();
  snap.etf = [];
  const sig = buildSignal('BTC', snap, 'balanced');
  check('no crash without ETF rows', Number.isFinite(sig.strength));
  check('explanation notes missing ETF data', sig.explanation.join(' ').includes('no BTC ETF flow data'));
}

console.log('== desk analysis on the real sample snapshot ==');
{
  const snap = JSON.parse(readFileSync(new URL('./data/snapshot.json', import.meta.url), 'utf8'));
  const desk = analyzeDesk(snap, 'balanced');
  check('6 signals (one per currency)', desk.signals.length === 6, `got ${desk.signals.length}`);
  check('signals sorted by |strength| desc',
    desk.signals.every((s, i, arr) => i === 0 || Math.abs(arr[i - 1].strength) >= Math.abs(s.strength)));
  check('no NaN strengths', desk.signals.every((s) => Number.isFinite(s.strength)));
  check('caps within profile max', desk.signals.every((s) => s.capPct <= 5));
  check('regime is a string', typeof desk.regime === 'string' && desk.regime.length > 0);
  console.log(`  sample desk regime: ${desk.regime} (${desk.regimeScore})`);
  for (const s of desk.signals) console.log(`    ${s.asset}: ${s.direction} ${s.strength} cap ${s.capPct}% [${s.confirmations.join(',')}]`);
}

console.log('== signal history ==');
{
  const snap = JSON.parse(readFileSync(new URL('./data/snapshot.json', import.meta.url), 'utf8'));
  const entry = summarizeDesk(analyzeDesk(snap, 'balanced'));
  check('history entry has regime + 6 signals', entry.signals.length === 6 && typeof entry.regime === 'string');
  let log = appendHistoryEntry([], entry);
  check('append to empty log', log.length === 1 && log[0] === entry);
  for (let i = 0; i < 35; i++) log = appendHistoryEntry(log, { ...entry, fetched_at: `t${i}` });
  check('log caps at 30, newest first', log.length === 30 && log[0].fetched_at === 't34');
  check('non-array log tolerated', appendHistoryEntry(null, entry).length === 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
