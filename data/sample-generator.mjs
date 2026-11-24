// SOSO Desk — sample snapshot generator.
// Writes data/snapshot.json with source:"sample" so the dashboard demo is
// verifiable WITHOUT an API key. Values are ILLUSTRATIVE (plausible market
// levels for late Nov 2026), NOT real market data — the dashboard labels
// them SAMPLE everywhere and the README says so. Run: node data/sample-generator.mjs
// The live fetcher (fetch-data.mjs) overwrites this file with real data
// whenever SOSO_API_KEY is set; re-run this script to restore the sample.

import { writeFileSync, renameSync } from 'node:fs';
import { scoreNewsSentiment, analyzeDesk, summarizeDesk } from '../signal-engine.js';

const OUT = new URL('./snapshot.json', import.meta.url);

const market = [
  { symbol: 'BTC', name: 'Bitcoin', currency_id: '1673723677362319866', price: 87400, change_pct_24h: 1.84, turnover_24h: 38200000000, turnover_rate: 0.024, high_24h: 88950, low_24h: 85210, marketcap: 1745000000000, fdv: 1837000000000, marketcap_rank: 1, ath: 126080, down_from_ath: '-30.7%', cycle_low: 15400, up_from_cycle_low: '+467.5%' },
  { symbol: 'ETH', name: 'Ethereum', currency_id: '1673723677362319867', price: 2950, change_pct_24h: 2.41, turnover_24h: 21400000000, turnover_rate: 0.061, high_24h: 3010, low_24h: 2840, marketcap: 355000000000, fdv: 355000000000, marketcap_rank: 2, ath: 4891, down_from_ath: '-39.7%', cycle_low: 880, up_from_cycle_low: '+235.2%' },
  { symbol: 'SOL', name: 'Solana', currency_id: '1673723677362319875', price: 132.5, change_pct_24h: -0.82, turnover_24h: 4100000000, turnover_rate: 0.055, high_24h: 136.8, low_24h: 129.4, marketcap: 72000000000, fdv: 81000000000, marketcap_rank: 5, ath: 293.3, down_from_ath: '-54.8%', cycle_low: 8.0, up_from_cycle_low: '+1556.3%' },
  { symbol: 'BNB', name: 'BNB', currency_id: '1673723677362319869', price: 861, change_pct_24h: 0.63, turnover_24h: 1900000000, turnover_rate: 0.016, high_24h: 872, low_24h: 849, marketcap: 120000000000, fdv: 172000000000, marketcap_rank: 4, ath: 1379, down_from_ath: '-37.6%', cycle_low: 203, up_from_cycle_low: '+324.1%' },
  { symbol: 'XRP', name: 'XRP', currency_id: '1673723677362319871', price: 2.14, change_pct_24h: -1.12, turnover_24h: 2800000000, turnover_rate: 0.021, high_24h: 2.19, low_24h: 2.09, marketcap: 128000000000, fdv: 214000000000, marketcap_rank: 3, ath: 3.84, down_from_ath: '-44.3%', cycle_low: 0.28, up_from_cycle_low: '+664.3%' },
  { symbol: 'DOGE', name: 'Dogecoin', currency_id: '1673723677362319874', price: 0.154, change_pct_24h: 3.05, turnover_24h: 1600000000, turnover_rate: 0.068, high_24h: 0.159, low_24h: 0.147, marketcap: 23000000000, fdv: 23000000000, marketcap_rank: 8, ath: 0.731, down_from_ath: '-78.9%', cycle_low: 0.05, up_from_cycle_low: '+208.0%' },
];

const etf = [
  { asset: 'BTC', ticker: 'IBIT', name: 'iShares Bitcoin Trust', date: '2026-11-24', sponsor_fee: 0.0025, net_inflow: 412000000, cum_inflow: 61200000000, net_assets: 58400000000, mkt_price: 61.2, prem_dsc: 0.0004, value_traded: 2950000000, volume: 48200000 },
  { asset: 'BTC', ticker: 'FBTC', name: 'Fidelity Wise Origin Bitcoin Fund', date: '2026-11-24', sponsor_fee: 0.0025, net_inflow: 148000000, cum_inflow: 21400000000, net_assets: 20100000000, mkt_price: 54.8, prem_dsc: -0.0002, value_traded: 812000000, volume: 14800000 },
  { asset: 'BTC', ticker: 'BITB', name: 'Bitwise Bitcoin ETF', date: '2026-11-24', sponsor_fee: 0.002, net_inflow: 32000000, cum_inflow: 3100000000, net_assets: 2900000000, mkt_price: 41.3, prem_dsc: 0.0001, value_traded: 121000000, volume: 2900000 },
  { asset: 'ETH', ticker: 'ETHA', name: 'iShares Ethereum Trust', date: '2026-11-24', sponsor_fee: 0.0025, net_inflow: 96000000, cum_inflow: 9800000000, net_assets: 9100000000, mkt_price: 27.4, prem_dsc: 0.0003, value_traded: 402000000, volume: 14700000 },
  { asset: 'ETH', ticker: 'FETH', name: 'Fidelity Ethereum Fund', date: '2026-11-24', sponsor_fee: 0.0025, net_inflow: 41000000, cum_inflow: 2900000000, net_assets: 2600000000, mkt_price: 25.9, prem_dsc: -0.0001, value_traded: 118000000, volume: 4500000 },
  { asset: 'SOL', ticker: 'BSOL', name: 'Bitwise Solana ETF', date: '2026-11-24', sponsor_fee: 0.002, net_inflow: 18000000, cum_inflow: 420000000, net_assets: 390000000, mkt_price: 18.6, prem_dsc: 0.0002, value_traded: 46000000, volume: 2400000 },
  { asset: 'SOL', ticker: 'SSOL', name: '21Shares Solana ETF', date: '2026-11-24', sponsor_fee: 0.0021, net_inflow: 9000000, cum_inflow: 180000000, net_assets: 170000000, mkt_price: 16.2, prem_dsc: 0.0000, value_traded: 21000000, volume: 1300000 },
];

const now = Date.now();
const news = [
  { id: 1, title: 'Bitcoin ETFs see $592M in net inflows as institutional buying accelerates', source_link: 'https://sosovalue.xyz/news/cluster/1', release_time: now - 2 * 3600_000 },
  { id: 2, title: 'Ethereum rallies past $2,950 on strong ETF demand and network upgrades', source_link: 'https://sosovalue.xyz/news/cluster/2', release_time: now - 3 * 3600_000 },
  { id: 3, title: 'Solana network activity cools as traders rotate into Bitcoin', source_link: 'https://sosovalue.xyz/news/cluster/3', release_time: now - 4 * 3600_000 },
  { id: 4, title: 'Analysts flag record stablecoin inflows to exchanges ahead of year-end', source_link: 'https://sosovalue.xyz/news/cluster/4', release_time: now - 5 * 3600_000 },
  { id: 5, title: 'Crypto market cap reclaims $3 trillion as risk appetite returns', source_link: 'https://sosovalue.xyz/news/cluster/5', release_time: now - 6 * 3600_000 },
  { id: 6, title: 'Regulator warns on leveraged crypto products after volatile week', source_link: 'https://sosovalue.xyz/news/cluster/6', release_time: now - 8 * 3600_000 },
  { id: 7, title: 'Dogecoin jumps 3% as memecoin volumes surge across exchanges', source_link: 'https://sosovalue.xyz/news/cluster/7', release_time: now - 9 * 3600_000 },
  { id: 8, title: 'XRP slips as profit-taking hits altcoins', source_link: 'https://sosovalue.xyz/news/cluster/8', release_time: now - 11 * 3600_000 },
  { id: 9, title: 'Major bank launches tokenized fund on Ethereum', source_link: 'https://sosovalue.xyz/news/cluster/9', release_time: now - 13 * 3600_000 },
  { id: 10, title: 'Bitcoin miners report record hash rate as difficulty adjusts upward', source_link: 'https://sosovalue.xyz/news/cluster/10', release_time: now - 15 * 3600_000 },
];

const newsSentiment = scoreNewsSentiment(news.map((n) => n.title));

const snapshot = {
  schema_version: 1,
  source: 'sample',
  fetched_at: new Date().toISOString(),
  fetch_commit: 'sample',
  generator: 'data/sample-generator.mjs — ILLUSTRATIVE values, not real market data',
  note: 'SAMPLE DATA: illustrative values for demo purposes. Run `SOSO_API_KEY=<key> node fetch-data.mjs` for live SoSoValue data.',
  sections: {
    market: { status: 'sample', fetched_at: new Date().toISOString(), error: null },
    etf: { status: 'sample', fetched_at: new Date().toISOString(), error: null },
    news: { status: 'sample', fetched_at: new Date().toISOString(), error: null },
  },
  market,
  etf,
  news,
  news_sentiment: newsSentiment,
};

const tmp = `${OUT.pathname}.tmp`;
writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
renameSync(tmp, OUT.pathname);
console.log(`WROTE sample ${OUT.pathname} — market ${market.length}, etf ${etf.length}, news ${news.length}, sentiment ${newsSentiment.score}`);

// Seed the signal-history log with one entry from this sample snapshot
// (labelled sample, like everything else in the demo data).
const logOut = new URL('./signals-log.json', import.meta.url);
const logTmp = `${logOut.pathname}.tmp`;
writeFileSync(logTmp, `${JSON.stringify([summarizeDesk(analyzeDesk(snapshot, 'balanced'))], null, 2)}\n`);
renameSync(logTmp, logOut.pathname);
console.log(`WROTE sample ${logOut.pathname} — 1 entry (sample)`);
