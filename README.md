# SOSO Desk — an explainable, risk-gated on-chain finance copilot

**Live demo:** https://kriptmwan.github.io/soso-desk/
**Buildathon:** [SoSoValue Wave 3 — "Build Your One-Person On-Chain Finance Business"](https://app.akindo.io/wave-hacks/JBEQXgN4Zi2jA3wA) (AKINDO, deadline 27 Nov 2026)

SOSO Desk turns SoSoValue market snapshots, ETF flows and hot news into **ranked, explainable trading signals with risk controls** — for one person managing their own crypto, without a team, a terminal, or a paid data feed.

- **Weighted scoring matrix (shown on every signal):** ETF flows 50% · market momentum 30% · news sentiment 20%. The math is visible, not a black box.
- **Confirmation rule:** a directional call needs ≥ 2 of 3 inputs agreeing in sign. Otherwise the desk says WAIT.
- **Conflict detection:** when inputs genuinely disagree, the call is DIVERGENT — size 0, no trade. Whipsaws blocked, not averaged away.
- **Position-size caps:** profile max (Conservative 2% / Balanced 5% / Aggressive 10% per trade) scaled by signal strength.
- **Trade ticket:** one click copies a plain-text ticket (call, size, why, risks) to paste anywhere.
- **What-If mode:** flip ETF flows or news sentiment and watch every signal recompute live in your browser — proof the engine runs client-side and is not hardcoded.
- **Signal history:** every refresh appends one entry to `data/signals-log.json` (regime + per-asset calls, last 30 runs) — the desk's track record, rendered on the dashboard. No accountability-free signals.
- **Read-only by design:** SOSO Desk never moves funds, never holds keys, never asks for a wallet. Decision support, not financial advice.

## The demo, honestly

The dashboard reads `data/snapshot.json`. Every section carries a **LIVE / SAMPLE / STALE / FAILED** badge with its own fetch timestamp, and the header badge tells you the overall state.

- Right now the checked-in snapshot is **SAMPLE** (illustrative values, clearly labelled) — see [Known limitation](#known-limitation) for why, and how it goes live.
- When the repo secret is set, the scheduled workflow refreshes the snapshot from the real API every 6 hours and the badges flip to LIVE automatically. No code change needed.

## Quick start (works from a clean checkout)

```bash
git clone https://github.com/kriptmwan/soso-desk.git
cd soso-desk
npm test            # 30 checks on the signal engine — no key, no network
npm run serve       # serves the dashboard at http://localhost:8000
```

Open http://localhost:8000 — the dashboard renders from the checked-in sample snapshot.

### Going live with your own key (free)

1. Create a free SoSoValue account and apply for a key at https://sosovalue.com/developer/dashboard ("Apply your Key"). Free tier: all v1 endpoints, 100,000 requests/month, 20/minute.
2. Run the fetcher (never commit the key — it stays in your shell):
   ```bash
   SOSO_API_KEY=<your-key> node fetch-data.mjs
   ```
   This rewrites `data/snapshot.json` with live data. Re-run `npm run serve` to see LIVE badges.
3. To keep the **public demo** live, add the same key as a repo secret named `SOSO_API_KEY` (Repo → Settings → Secrets and variables → Actions → New repository secret), then trigger the workflow once: Actions → "Refresh snapshot" → Run workflow. It refreshes every 6 hours after that.

No key? `node fetch-data.mjs` without `SOSO_API_KEY` exits cleanly and keeps the sample snapshot. `node data/sample-generator.mjs` restores the sample at any time.

## Architecture — the "air-gapped data pipeline"

```
SoSoValue API ──► fetch-data.mjs ──► data/snapshot.json ──► GitHub Pages
  (key in env /        (Node, no deps)   (committed,          (static site,
   repo secret)                           per-section           reads the file)
                                          provenance)
```

Why this shape: it eliminates the three classic hackathon killers — API rate limits, CORS errors on GitHub Pages, and leaked secrets. The key never reaches the browser or the repo; the demo stays up even if the API is down; and the signal engine is deterministically testable because its input is a file.

| File | What it does |
|---|---|
| `signal-engine.js` | Deterministic rules engine (ES module, shared by dashboard + tests). Weighted matrix, confirmation rule, conflict detection, position caps, trade-ticket text, news-sentiment lexicon. |
| `fetch-data.mjs` | Calls the SoSoValue API (`/currencies` → per-currency `/market-snapshot`; `/etfs` → per-ticker `/market-snapshot`; `/news`). Per-section LIVE/SAMPLE/STALE/FAILED status, atomic writes, never overwrites good data with a failed run. |
| `data/snapshot.json` | The snapshot the dashboard reads. Schema v1: `source`, `fetched_at`, `fetch_commit`, `sections{...}`, `market[]`, `etf[]`, `news[]`, `news_sentiment{}`. |
| `data/sample-generator.mjs` | Regenerates the labelled sample snapshot (illustrative values, real currency IDs). |
| `index.html` + `app.js` | The dashboard. No build step, no CDN dependencies. |
| `data/signals-log.json` | Signal history: one entry per refresh (regime + per-asset calls), last 30 runs. Rendered on the dashboard. |
| `test-engine.mjs` | 30 engine checks (sentiment, ACCUMULATE/DIVERGENT/WAIT, caps, What-If, no-ETF edge, history helpers, sample-snapshot end-to-end). Run in CI on every push (`.github/workflows/ci.yml`). |
| `.github/workflows/refresh-snapshot.yml` | Every 6h + manual: fetch with the `SOSO_API_KEY` secret, commit if changed. |

## How the signal is built

For each tracked asset (BTC, ETH, SOL, BNB, XRP, DOGE):

| Input | Weight | Normalisation |
|---|---|---|
| ETF flows | 50% | Total daily net inflow across the asset's US spot ETFs; ±$500M → ±100 |
| Market momentum | 30% | 24h price change; ±5% → ±100 |
| News sentiment | 20% | Keyword lexicon over headlines: (bullish − bearish) / scored; −1…1 → −100…100 |

`strength = 0.5·ETF + 0.3·Market + 0.2·News` (−100…100). Direction: **ACCUMULATE** if strength ≥ +15 with ≥ 2 confirmations; **REDUCE** if ≤ −15 with ≥ 2; **DIVERGENT** if any component ≥ 25 points against the total while |strength| < 40 (size forced to 0); otherwise **WAIT**.

The news lexicon lives in `signal-engine.js` (`BULLISH_WORDS` / `BEARISH_WORDS`) — public, auditable, and the bullish/bearish counts are shown in the UI next to the score.

## API integration (what is genuinely called)

Base `https://openapi.sosovalue.com/openapi/v1`, header `x-soso-api-key`. All GET, all free-tier. Verified against the official docs (https://sosovalue-1.gitbook.io/sosovalue-api-doc) and live from the build machine where the edge allows:

- `GET /currencies` → resolve `BTC/ETH/SOL/BNB/XRP/DOGE` to currency IDs (name-preferred, so Dogecoin wins over same-symbol impostors).
- `GET /currencies/{id}/market-snapshot` → price, 24h change, volume, market cap, ATH distance.
- `GET /etfs?symbol=BTC&country_code=US` (+ ETH, SOL) → tickers; `GET /etfs/{ticker}/market-snapshot` → net inflow, cumulative inflow, net assets, premium/discount.
- `GET /news?limit=20&language=en` → latest headlines for the sentiment engine.

~18 requests per refresh run, sequential, inside the 20/minute limit.

## Known limitation

Verified 24 Nov 2026: from the build VM, Cloudflare's edge blocks SoSoValue's `/market-snapshot`, `/etfs` and `/news/hot` paths with an HTTP 403 **even with a valid, active key** — while `/currencies` and `/news` return code 0 with real data. This is a network-level edge block, not an auth failure and not missing integration: the code calls the real endpoints on every run.

- The fetcher therefore uses `/news` (same feed family, works) instead of `/news/hot`.
- Market and ETF sections retry live on every run; if the block is still in place, they keep the previous data labelled STALE/SAMPLE — never presented as live.
- The GitHub Actions runner has different egress IPs and may pass Cloudflare where the build VM does not. The workflow run log is the test: if its market/ETF sections come back LIVE, the demo is fully live; if they 403 too, the dashboard keeps saying so honestly.

## Judging criteria — where the points come from

| Criterion (weight) | How SOSO Desk answers it |
|---|---|
| User Value 30% | One person, one page: ranked signals with a size cap and a copy-paste ticket. No setup, no wallet, no paywall. |
| Functionality & Demo 25% | Live dashboard + working refresh pipeline + 30 passing engine tests. Demo works with or without a key. |
| Logic / Workflow / Design 20% | Weighted matrix with visible math, confirmation rule, conflict detection, What-If mode, risk profiles. |
| Data / API Integration 15% | Three live SoSoValue endpoints with per-section provenance; key via env/secret only. |
| UX & Clarity 10% | One screen, plain language, every number labelled with its source and age. |

## What was deliberately NOT built

- **SoDEX:** skipped entirely — its mainnet key needs a token deposit and Silver rank (not free). No portfolio endpoint exists in the SoSoValue API, so no holdings/PnL features were faked.
- **Trade execution:** out of scope by design. The copilot proposes; the human decides and acts elsewhere.

## License

MIT — see [LICENSE](LICENSE).
