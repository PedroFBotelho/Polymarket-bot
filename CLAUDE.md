# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Two things layered together:

1. **`@catalyst-team/poly-sdk`** — a publishable TypeScript SDK for Polymarket (`src/`, exported via `src/index.ts`): API clients (Gamma, CLOB/Data, Subgraph), services (trading, arbitrage, dip-arb, smart-money copy-trading, wallet/on-chain ops), a backtest engine, and core infra (cache, rate limiter, errors).
2. **A trading bot built on that SDK**, with a React dashboard for live monitoring/control. The bot has **two parallel entry points** with duplicated config/logic (see below) — always check which one you're editing.

## Commands

```bash
# SDK build / typecheck (only compiles src/, not the bot entry points)
npm run build          # tsc
npm run dev            # tsc --watch

# Tests (vitest)
npm test                                    # unit tests: src/**/*.test.ts
npm run test:watch
npm run test:integration                    # src/__tests__/integration/**, real API calls, 60s timeout
npx vitest run src/utils/risk.test.ts       # single file
npx vitest run -t "test name"               # single test by name

# Backtesting
npm run backtest        # tsx src/backtest/runner.ts

# Running the bot (not npm scripts — run directly with tsx)
npx tsx bot-with-dashboard.ts   # bot + dashboard, the maintained/documented entry point (README)
npx tsx bot-config.ts           # bot without dashboard, standalone reference config (BEGINNER_GUIDE)

# Dashboard frontend (separate npm project in dashboard/)
cd dashboard && npm install && npm run build   # must be built before running the bot with dashboard
cd dashboard && npm run dev                    # Vite dev server, for UI-only iteration
```

Root `tsconfig.json` only includes `src/**/*` and `scripts/dip-arb/**/*` — `bot-with-dashboard.ts` and `bot-config.ts` are never type-checked by `npm run build`; they only run via `tsx`, which does its own transpilation. Keep that in mind when touching either file: a type error there won't show up in `tsc`, only in `vitest`/at runtime.

## Architecture

### SDK layer (`src/`)
- `clients/` — thin wrappers over Polymarket's Gamma API, Data/CLOB API, Subgraph (Goldsky), and the bridge client. Exported from `src/index.ts`.
- `core/` — cache (`cache.ts`, `unified-cache.ts`), `rate-limiter.ts`, typed errors (`errors.ts`), shared `types.ts`.
- `services/` — the trading/analysis logic built on the clients: `trading-service.ts` (direct orders), `arbitrage-service.ts`, `dip-arb-service.ts`, `smart-money-service.ts` (copy-trading), `leaderboard-provider.ts` / `monid-leaderboard-provider.ts`, `wallet-service.ts`, `onchain-service.ts` (split/merge/redeem CTF), `swap-service.ts`, `binance-service.ts` (K-line analysis), `copy-pnl-tracker.ts`.
- `utils/` — `risk.ts` (the risk-gate logic: exposure caps, loss-streak pause, wallet quality gates — shared by both bot entry points), `paper-ledger.ts` (dry-run/paper trade simulation and settlement), `wallet-list.ts` (parses `CUSTOM_WALLETS`), `closed-positions.ts`, `price-utils.ts`.
- `backtest/` — a JSONL order-book replay engine (`runner.ts`, `replay.ts`) with per-strategy modules (`smart-money.ts`, `dip-arb.ts`, `direct.ts`, `xmarket.ts`, `competition.ts`, `correlation.ts`, `decay.ts`, `pendulum.ts`) modeling fees/gas against historical snapshots.
- `dashboard/` — the bot-side half of the dashboard: `server.ts` (HTTP + WebSocket API, token-authenticated), `state-emitter.ts` (pushes bot state to connected clients), `session-history.ts` (persists PnL/session data to `data/`), `types.ts` (the `BotState`/`BotConfig` contract shared with the frontend).

### Bot layer (repo root)
- `bot-with-dashboard.ts` and `bot-config.ts` each independently define `CONFIG` (capital, risk, per-strategy settings) and wire the SDK services into a run loop. They are **not** DRY by design/history — a fix in one (e.g. a risk-gate correction) does not automatically apply to the other. `docs/DATA_SOURCES_GUIDE.md` and `docs/AUDIT_FIXES.md` track known drift between them. When asked to fix bot behavior, check whether the fix needs to land in both files.
- Both read strategy toggles and risk thresholds from env vars (`SMARTMONEY_ENABLED`, `ARBITRAGE_ENABLED`, `DIPARB_ENABLED`, `TREND_ANALYSIS_ENABLED`, `DAILY_MAX_LOSS_PCT`, `MONTHLY_MAX_LOSS_PCT`, `MAX_DRAWDOWN_PCT`, `TOTAL_MAX_LOSS_PCT`, `CAPITAL_USD`, `DRY_RUN`, `CUSTOM_WALLETS`, `POLYGON_RPC_URL`) — see `.env.example` for the full set and defaults.
- Risk protection is layered (daily/monthly/drawdown/total-loss halt/loss-streak/exposure cap — implemented in `src/utils/risk.ts`) and enforced before every trade via a `PreExecutionGuard`-shaped check, not just observed after the fact.
- `CUSTOM_WALLETS` (extra copy-trade targets) still has to pass the same quality gates (`evaluateWalletQuality`) as leaderboard-sourced wallets — never followed unconditionally.

### Dashboard frontend (`dashboard/`)
- Separate Vite + React project (its own `package.json`, not part of the root npm workspace). Talks to `src/dashboard/server.ts` over HTTP/WebSocket, authenticated with `DASHBOARD_TOKEN` (auto-generated per run if unset, printed once at startup).
- `dashboard/src/components/` holds the panels (balances, positions, wallet list, risk status, paper positions, etc.); `dashboard/src/types.ts` mirrors `src/dashboard/types.ts` on the bot side — when changing the state shape, update both.
- Binds to `127.0.0.1` by default; reaching it from another machine requires explicitly setting `DASHBOARD_HOST=0.0.0.0` **and** a strong `DASHBOARD_TOKEN`.

### Safety-critical invariants
- Trading defaults to `DRY_RUN=true` / paper mode (`src/utils/paper-ledger.ts` simulates fills and settlement) — going live is an explicit opt-in, never a default flipped incidentally.
- The private key (`POLYMARKET_PRIVATE_KEY`) and dashboard token live only in `.env` / the systemd `EnvironmentFile` in `docs/DEPLOY.md`'s deploy plan — never hardcode, log, or print them.
- `docs/DEPLOY.md` documents a VPS hardening plan (SSH hardening, dedicated low-login `polybot` system user, code owned by a separate read-only user, secrets outside the repo, WireGuard access) that has since been executed once against a real DigitalOcean droplet — treat it as the reference for deployment, and keep it updated with anything found live during a deploy (several fixes already came from that).
- **Smart-money copy detection can silently miss trades — this is not a bug to "fix" here.** `realtime-service-v2.ts` wraps `@polymarket/real-time-data-client`, whose connection to `wss://ws-live-data.polymarket.com` drops with an abrupt code-1006 close fairly often (observed ~16 times in 2h20m on one deployment). The client auto-reconnects and `handleConnect()` correctly re-subscribes every previous topic, but there is no replay-since-timestamp: any activity Polymarket pushes during a drop is gone. A followed wallet's real trade can therefore never appear in the logs at all, with no error anywhere — confirmed by cross-checking a wallet's Polymarket activity feed against `journalctl` and finding the trade simply absent. Diagnose a "wallet traded but nothing copied, no skip logged either" report by grepping for `disconnected code` around that timestamp before assuming a filter/risk-guard issue.

## Docs map

`docs/README.md` is the index. Notable ones: `docs/DASHBOARD.md` (dashboard architecture/usage), `docs/DATA_SOURCES_GUIDE.md` and `docs/AUDIT_FIXES.md` (known gaps/drift between the two bot entry points), `docs/DEPLOY.md` (VPS deploy plan, pt-BR), `docs/architecture/` (SDK service-layer design), `SDK_DOCUMENTATION.md` (SDK API reference for consumers of the published package).
