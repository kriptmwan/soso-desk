// SOSO Desk — signal engine (deterministic, no model calls).
// Shared by the dashboard (browser, ES module) and the Node test harness.
// Inputs: a snapshot object (see data/snapshot.json schema) + a risk profile.
// Outputs: ranked, explainable signals with risk controls.
//
// Weighted scoring matrix (Gate 1, Gemma review):
//   ETF flows 50% | Market momentum 30% | News sentiment 20%
// Confirmation rule: a directional call needs >= 2 of 3 components agreeing
// in sign with the total. Conflicting inputs => DIVERGENT (no trade), not
// a watered-down Neutral.

export const WEIGHTS = { etf: 0.5, market: 0.3, news: 0.2 };

// Normalisation scales: a component hits +/-100 at these magnitudes.
export const SCALES = {
  etfFlowUsd: 500_000_000, // +/-$500M daily net ETF flow = +/-100
  marketPct24h: 5, // +/-5% 24h move = +/-100
};

export const PROFILES = {
  conservative: { label: 'Conservative', maxPositionPct: 2 },
  balanced: { label: 'Balanced', maxPositionPct: 5 },
  aggressive: { label: 'Aggressive', maxPositionPct: 10 },
};

export const DIRECTION = {
  ACCUMULATE: 'ACCUMULATE',
  REDUCE: 'REDUCE',
  WAIT: 'WAIT',
  DIVERGENT: 'DIVERGENT',
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// --- News sentiment: small keyword lexicon over titles. --------------------
// Deliberately transparent: the lexicon is public, the count is shown in the
// UI, and the method string is stored in the snapshot so anyone can audit it.
export const BULLISH_WORDS = [
  'surge', 'surges', 'rally', 'rallies', 'bullish', 'breakout', 'breaks out',
  'record', 'all-time high', 'approval', 'approved', 'inflow', 'inflows',
  'gains', 'gain', 'soars', 'soar', 'jumps', 'jump', 'adoption', 'accumulat',
  'buying', 'etf', 'launch', 'launches', 'positive', 'recovery', 'rebound',
  'strong', 'growth', 'milestone', 'institutional',
];
export const BEARISH_WORDS = [
  'crash', 'crashes', 'plunge', 'plunges', 'bearish', 'dump', 'dumps',
  'outflow', 'outflows', 'hack', 'hacked', 'ban', 'banned', 'lawsuit',
  'sues', 'fear', 'fears', 'decline', 'declines', 'slump', 'slumps',
  'sell-off', 'selloff', 'selling', 'drop', 'drops', 'falls', 'fall',
  'warning', 'risk', 'probe', 'investigat', 'fraud', 'liquidat',
];

export function scoreNewsSentiment(titles) {
  const list = (titles || []).filter((t) => typeof t === 'string');
  let bull = 0;
  let bear = 0;
  for (const raw of list) {
    const t = raw.toLowerCase();
    let b = false;
    let s = false;
    for (const w of BULLISH_WORDS) if (t.includes(w)) { b = true; break; }
    for (const w of BEARISH_WORDS) if (t.includes(w)) { s = true; break; }
    if (b && !s) bull += 1;
    else if (s && !b) bear += 1;
    // Titles matching both are counted as contested and ignored.
  }
  const scored = bull + bear;
  const score = scored === 0 ? 0 : (bull - bear) / scored; // -1 .. 1
  return {
    score: Math.round(score * 100) / 100,
    bullish: bull,
    bearish: bear,
    contested: list.length - scored,
    total: list.length,
    method: 'keyword lexicon over news titles (bullish/bearish word lists in signal-engine.js)',
  };
}

const fmtUsd = (n) => {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
};
const fmtPct = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

// --- Core: one signal per asset. -------------------------------------------
export function buildSignal(asset, snap, profileName = 'balanced', overrides = {}) {
  const profile = PROFILES[profileName] || PROFILES.balanced;
  const market = (snap.market || []).find((m) => m.symbol === asset);
  const etfRows = (snap.etf || []).filter((e) => e.asset === asset);
  const news = snap.news_sentiment || { score: 0, bullish: 0, bearish: 0, total: 0 };

  // Components, each -100..100. Overrides (What-If) replace a component's
  // raw input before normalisation: { etfFlowUsd, marketPct24h, newsScore }.
  const etfFlowUsd = overrides.etfFlowUsd !== undefined
    ? overrides.etfFlowUsd
    : etfRows.reduce((s, e) => s + (Number(e.net_inflow) || 0), 0);
  const etfComponent = etfRows.length === 0 && overrides.etfFlowUsd === undefined
    ? { value: 0, note: `no ${asset} ETF flow data in this snapshot — component neutral` }
    : { value: clamp((etfFlowUsd / SCALES.etfFlowUsd) * 100, -100, 100) };

  const marketPct = overrides.marketPct24h !== undefined
    ? overrides.marketPct24h
    : (market ? Number(market.change_pct_24h) || 0 : 0);
  const marketComponent = { value: clamp((marketPct / SCALES.marketPct24h) * 100, -100, 100) };

  const newsScore = overrides.newsScore !== undefined ? overrides.newsScore : news.score;
  const newsComponent = { value: clamp(newsScore * 100, -100, 100) };

  const contributions = {
    etf: Math.round(WEIGHTS.etf * etfComponent.value * 10) / 10,
    market: Math.round(WEIGHTS.market * marketComponent.value * 10) / 10,
    news: Math.round(WEIGHTS.news * newsComponent.value * 10) / 10,
  };
  const strength = Math.round(
    (contributions.etf + contributions.market + contributions.news) * 10,
  ) / 10;

  // Confirmation: components with |value| >= 10 that agree in sign with the total.
  const dir = Math.sign(strength);
  const agreeing = ['etf', 'market', 'news'].filter((k) => {
    const v = { etf: etfComponent.value, market: marketComponent.value, news: newsComponent.value }[k];
    return dir !== 0 && Math.abs(v) >= 10 && Math.sign(v) === dir;
  });
  const disagreeing = ['etf', 'market', 'news'].filter((k) => {
    const v = { etf: etfComponent.value, market: marketComponent.value, news: newsComponent.value }[k];
    // >= 25 = a material move (>= $125M flow, >= 1.25% price, >= 0.25 sentiment).
    // Smaller wiggles are noise, not a conflict.
    return Math.abs(v) >= 25 && Math.sign(v) !== 0 && dir !== 0 && Math.sign(v) !== dir;
  });

  let direction;
  let action;
  if (disagreeing.length > 0 && Math.abs(strength) < 40) {
    direction = DIRECTION.DIVERGENT;
    action = 'NO TRADE — inputs conflict; wait for confirmation';
  } else if (strength >= 15 && agreeing.length >= 2) {
    direction = DIRECTION.ACCUMULATE;
    action = 'Accumulate within the position cap below';
  } else if (strength <= -15 && agreeing.length >= 2) {
    direction = DIRECTION.REDUCE;
    action = 'Reduce exposure within the position cap below';
  } else {
    direction = DIRECTION.WAIT;
    action = 'Wait — no confirmed edge right now';
  }

  const confidence = direction === DIRECTION.DIVERGENT
    ? 'low'
    : agreeing.length >= 3 ? 'high' : agreeing.length === 2 ? 'medium' : 'low';

  // Position-size cap: profile base scaled by |strength|, zero unless confirmed.
  const capPct = (direction === DIRECTION.ACCUMULATE || direction === DIRECTION.REDUCE)
    ? Math.round(profile.maxPositionPct * (Math.abs(strength) / 100) * 10) / 10
    : 0;

  const explanation = [];
  if (etfRows.length > 0 || overrides.etfFlowUsd !== undefined) {
    explanation.push(
      `ETF flows ${etfFlowUsd >= 0 ? '+' : ''}${fmtUsd(etfFlowUsd)} net today across ${etfRows.length} ${asset} ETF(s) → component ${etfComponent.value >= 0 ? '+' : ''}${Math.round(etfComponent.value)} (weight 50%, contributes ${contributions.etf >= 0 ? '+' : ''}${contributions.etf})`,
    );
  } else {
    explanation.push(etfComponent.note);
  }
  explanation.push(
    `${asset} ${fmtPct(marketPct)} in 24h (price ${market ? `$${Number(market.price).toLocaleString('en-US')}` : 'n/a'}) → component ${marketComponent.value >= 0 ? '+' : ''}${Math.round(marketComponent.value)} (weight 30%, contributes ${contributions.market >= 0 ? '+' : ''}${contributions.market})`,
  );
  explanation.push(
    `News sentiment ${newsScore >= 0 ? '+' : ''}${newsScore.toFixed(2)} (${news.bullish} bullish / ${news.bearish} bearish of ${news.total} headlines) → component ${newsComponent.value >= 0 ? '+' : ''}${Math.round(newsComponent.value)} (weight 20%, contributes ${contributions.news >= 0 ? '+' : ''}${contributions.news})`,
  );
  if (direction === DIRECTION.DIVERGENT) {
    explanation.push(
      `Conflict: ${disagreeing.join(' + ')} point(s) against the total — risk control blocks a directional call.`,
    );
  }

  const risks = [];
  if (market && market.down_from_ath !== '' && market.down_from_ath !== null && market.down_from_ath !== undefined) {
    risks.push(`${asset} is ${market.down_from_ath} below its all-time high — momentum can reverse fast.`);
  }
  if (etfRows.some((e) => Number(e.prem_dsc) < -0.005)) {
    risks.push('At least one tracked ETF trades at a discount to NAV — flow data may lag price.');
  }
  if (direction === DIRECTION.DIVERGENT) risks.push('Divergent inputs historically precede whipsaws; size 0 until two inputs agree.');
  if (news.total < 5) risks.push('Few headlines in this snapshot — news component is thin.');
  if (risks.length === 0) risks.push('Standard market risk applies — this is decision support, not financial advice.');

  return {
    asset,
    direction,
    strength,
    components: {
      etf: Math.round(etfComponent.value * 10) / 10,
      market: Math.round(marketComponent.value * 10) / 10,
      news: Math.round(newsComponent.value * 10) / 10,
    },
    contributions,
    confirmations: agreeing,
    disagreeing,
    confidence,
    capPct,
    profile: profile.label,
    action,
    explanation,
    risks,
    inputs: {
      etfFlowUsd,
      marketPct24h: marketPct,
      newsScore,
      etfTickers: etfRows.map((e) => e.ticker),
    },
  };
}

// --- Whole-desk analysis. ----------------------------------------------------
export function analyzeDesk(snap, profileName = 'balanced', overridesByAsset = {}) {
  const assets = (snap.market || []).map((m) => m.symbol);
  const signals = assets.map((a) =>
    buildSignal(a, snap, profileName, overridesByAsset[a] || {}),
  );
  signals.sort((a, b) => Math.abs(b.strength) - Math.abs(a.strength));

  const mean = signals.length
    ? signals.reduce((s, x) => s + x.strength, 0) / signals.length
    : 0;
  const divergentCount = signals.filter((s) => s.direction === DIRECTION.DIVERGENT).length;
  const regime = divergentCount > 0 && Math.abs(mean) < 40
    ? 'DIVERGENT — mixed signals, trade small or not at all'
    : mean >= 15 ? 'RISK-ON — flows, price and news mostly agree upward'
    : mean <= -15 ? 'RISK-OFF — flows, price and news mostly agree downward'
    : 'NEUTRAL — no confirmed market edge';

  return {
    generatedAt: new Date().toISOString(),
    source: snap.source || 'unknown',
    snapshotFetchedAt: snap.fetched_at || null,
    profile: (PROFILES[profileName] || PROFILES.balanced).label,
    regime,
    regimeScore: Math.round(mean * 10) / 10,
    signals,
    whatIf: Object.keys(overridesByAsset).length > 0,
  };
}

// --- Signal history (track record). ------------------------------------------
// The refresh pipeline appends one entry per run so the desk accumulates a
// verifiable track record (regime + per-asset calls). Pure + testable.
export function summarizeDesk(desk) {
  return {
    fetched_at: desk.snapshotFetchedAt,
    source: desk.source,
    regime: desk.regime,
    regimeScore: desk.regimeScore,
    profile: desk.profile,
    signals: desk.signals.map((s) => ({
      asset: s.asset, direction: s.direction, strength: s.strength, capPct: s.capPct,
    })),
  };
}

export function appendHistoryEntry(log, entry, maxEntries = 30) {
  const list = Array.isArray(log) ? [...log] : [];
  list.unshift(entry);
  return list.slice(0, maxEntries);
}
export function tradeTicket(signal, snap) {
  // Watermark: a ticket built from non-live data says so on its first line,
  // so nobody can act on sample/stale numbers by mistake (Gate 2, MiMo).
  const lines = [];
  if (snap.source !== 'live') {
    lines.push('⚠ SAMPLE/STALE DATA — illustrative only. Do NOT trade on this.');
  }
  lines.push(
    'SOSO DESK — TRADE TICKET',
    `Asset: ${signal.asset}  |  Call: ${signal.direction}  |  Strength: ${signal.strength}/100 (${signal.confidence} confidence)`,
    `Suggested size: up to ${signal.capPct}% of portfolio (${signal.profile} profile)`,
    `Action: ${signal.action}`,
    'Why:',
    ...signal.explanation.map((e) => `  - ${e}`),
    'Risks:',
    ...signal.risks.map((r) => `  - ${r}`),
    `Data: ${snap.source || 'unknown'} snapshot, fetched ${snap.fetched_at || 'n/a'} via SoSoValue API (market snapshot + ETF flows + hot news).`,
    'Not financial advice. Read-only decision support — SOSO Desk never moves funds.',
  ];
  return lines.join('\n');
}
