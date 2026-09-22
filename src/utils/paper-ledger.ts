/**
 * Paper-trading ledger: open simulated positions + settlement on resolution.
 *
 * In DRY RUN the bot "buys" shares but the simulator used to never score
 * them — PnL was only booked when a followed wallet SOLD, so a copy held to
 * resolution stayed at $0 forever. This ledger remembers each simulated
 * entry and books the outcome when the market resolves: winning shares pay
 * $1, losing shares $0.
 *
 * It also keeps a short history of finished positions (settled or closed by a
 * whale's sell) so the dashboard can list WHICH trades were copied and how they
 * ended, and it can be serialized so that survives a restart.
 *
 * Pure and I/O-free (like risk.ts) so it is unit-testable; the bot fetches
 * market resolution, applies the returned settlements to its own state, and
 * owns reading/writing the snapshot file.
 *
 * Conventions:
 *  - `costUsd` is what the simulated order spent (the copy notional).
 *  - Fees are not modelled here.
 *  - Only clear-cut resolutions settle (see payoutsFromMarket). Voided /
 *    50-50 markets stay open rather than guessing a payout.
 */

export type PaperStrategy = 'smartMoney' | 'direct';

export interface PaperPosition {
  id: string;
  strategy: PaperStrategy;
  tokenId: string;
  conditionId: string;
  /** Human label (question / slug) for logs and history. */
  market: string;
  outcome?: string;
  /** Followed wallet whose trade was copied (smart-money copies only). */
  wallet?: string;
  /** Shares held. */
  size: number;
  /** USDC spent to open (shrinks proportionally on partial closes). */
  costUsd: number;
  openedAt: number;
}

export interface PaperSettlement {
  position: PaperPosition;
  /** Final value per share: 1 (winner), 0 (loser). */
  payoutPerShare: number;
  payoutUsd: number;
  /** payoutUsd - costUsd. */
  pnlUsd: number;
  won: boolean;
}

export type PaperRowStatus = 'open' | 'won' | 'lost' | 'closed';

/** One line of the dashboard's paper-positions table (open or finished). */
export interface PaperRow {
  id: string;
  strategy: PaperStrategy;
  market: string;
  outcome?: string;
  wallet?: string;
  size: number;
  costUsd: number;
  /** costUsd / size. */
  entryPrice: number;
  openedAt: number;
  /** open | won / lost (settled at resolution) | closed (a followed wallet sold). */
  status: PaperRowStatus;
  closedAt?: number;
  payoutUsd?: number;
  pnlUsd?: number;
}

/** Serialized form written to disk by the bot. */
export interface PaperLedgerSnapshot {
  version: 1;
  seq: number;
  open: PaperPosition[];
  finished: PaperRow[];
}

const EPS = 1e-9;
/** Finished rows kept in memory / on disk (oldest dropped first). */
const MAX_FINISHED = 200;
const key = (s: string) => s.toLowerCase();

const isFiniteNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

function isValidPosition(p: unknown): p is PaperPosition {
  if (!p || typeof p !== 'object') return false;
  const x = p as Record<string, unknown>;
  return (
    typeof x.id === 'string' &&
    (x.strategy === 'smartMoney' || x.strategy === 'direct') &&
    typeof x.tokenId === 'string' && x.tokenId.length > 0 &&
    typeof x.conditionId === 'string' && x.conditionId.length > 0 &&
    typeof x.market === 'string' &&
    isFiniteNum(x.size) && x.size > 0 &&
    isFiniteNum(x.costUsd) && x.costUsd > 0 &&
    isFiniteNum(x.openedAt)
  );
}

function isValidRow(r: unknown): r is PaperRow {
  if (!r || typeof r !== 'object') return false;
  const x = r as Record<string, unknown>;
  return (
    typeof x.id === 'string' &&
    (x.strategy === 'smartMoney' || x.strategy === 'direct') &&
    typeof x.market === 'string' &&
    isFiniteNum(x.size) && isFiniteNum(x.costUsd) && isFiniteNum(x.entryPrice) && isFiniteNum(x.openedAt) &&
    (x.status === 'won' || x.status === 'lost' || x.status === 'closed')
  );
}

/** Numeric part of "paper-12" (0 if it does not look like one). */
const idNumber = (id: string) => {
  const m = /^paper-(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
};

export class PaperLedger {
  private positions: PaperPosition[] = [];
  private finished: PaperRow[] = [];
  private seq = 0;

  /** Record a simulated entry. Returns null (and records nothing) on bad input. */
  open(p: Omit<PaperPosition, 'id'>): PaperPosition | null {
    if (!p.tokenId || !p.conditionId) return null;
    if (!(p.size > 0) || !(p.costUsd > 0) || !Number.isFinite(p.size) || !Number.isFinite(p.costUsd)) return null;
    const position: PaperPosition = { ...p, id: `paper-${++this.seq}` };
    this.positions.push(position);
    return position;
  }

  /**
   * A tracked copy closed `closedSize` shares of `tokenId` (a followed wallet
   * sold). Shrink the oldest lots first, releasing cost pro rata, so they are
   * not settled a second time at resolution. Returns the cost released.
   *
   * `realizedUsd` (the PnL the caller booked for the whole close) is split
   * across the lots touched, pro rata by shares, and recorded on their
   * history rows.
   */
  reduce(tokenId: string, closedSize: number, realizedUsd?: number, now: number = Date.now()): number {
    if (!(closedSize > 0)) return 0;
    let remaining = closedSize;
    let released = 0;
    const touched: Array<{ lot: PaperPosition; take: number; cost: number }> = [];
    for (const p of this.positions) {
      if (remaining <= EPS) break;
      if (key(p.tokenId) !== key(tokenId)) continue;
      const take = Math.min(remaining, p.size);
      const cost = p.costUsd * (take / p.size);
      touched.push({ lot: { ...p }, take, cost });
      p.size -= take;
      p.costUsd -= cost;
      remaining -= take;
      released += cost;
    }
    this.positions = this.positions.filter(p => p.size > EPS);

    const totalTaken = touched.reduce((s, t) => s + t.take, 0);
    for (const { lot, take, cost } of touched) {
      const pnlUsd = isFiniteNum(realizedUsd) && totalTaken > 0 ? realizedUsd * (take / totalTaken) : undefined;
      this.pushFinished({
        id: lot.id,
        strategy: lot.strategy,
        market: lot.market,
        outcome: lot.outcome,
        wallet: lot.wallet,
        size: take,
        costUsd: cost,
        entryPrice: cost / take,
        openedAt: lot.openedAt,
        status: 'closed',
        closedAt: now,
        payoutUsd: pnlUsd === undefined ? undefined : cost + pnlUsd,
        pnlUsd,
      });
    }
    return released;
  }

  /**
   * Settle every open position in `conditionId` against final per-token
   * payouts (tokenId -> 0..1). Positions whose token is missing from
   * `payouts` stay open. Settled positions are removed and returned.
   */
  settleMarket(conditionId: string, payouts: Map<string, number>, now: number = Date.now()): PaperSettlement[] {
    const byToken = new Map<string, number>();
    for (const [t, v] of payouts) byToken.set(key(t), v);

    const settled: PaperSettlement[] = [];
    const still: PaperPosition[] = [];
    for (const p of this.positions) {
      const payoutPerShare = key(p.conditionId) === key(conditionId) ? byToken.get(key(p.tokenId)) : undefined;
      if (payoutPerShare === undefined) {
        still.push(p);
        continue;
      }
      const payoutUsd = p.size * payoutPerShare;
      const pnlUsd = payoutUsd - p.costUsd;
      // "won" = the outcome we bought paid out (not "PnL > 0": a winner
      // bought at $1.00 breaks even but is still a winner).
      const won = payoutPerShare > 0;
      settled.push({ position: p, payoutPerShare, payoutUsd, pnlUsd, won });
      this.pushFinished({
        id: p.id,
        strategy: p.strategy,
        market: p.market,
        outcome: p.outcome,
        wallet: p.wallet,
        size: p.size,
        costUsd: p.costUsd,
        entryPrice: p.costUsd / p.size,
        openedAt: p.openedAt,
        status: won ? 'won' : 'lost',
        closedAt: now,
        payoutUsd,
        pnlUsd,
      });
    }
    this.positions = still;
    return settled;
  }

  /** Distinct condition IDs with open positions, oldest position first. */
  conditionIds(limit = Infinity): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of [...this.positions].sort((a, b) => a.openedAt - b.openedAt)) {
      const k = key(p.conditionId);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p.conditionId);
      if (out.length >= limit) break;
    }
    return out;
  }

  openCount(): number {
    return this.positions.length;
  }

  openCostUsd(): number {
    return this.positions.reduce((sum, p) => sum + p.costUsd, 0);
  }

  /**
   * Rows for the dashboard: open positions first (newest first), then the most
   * recently finished ones (newest first). Capped so the payload stays small.
   */
  rows(opts: { maxOpen?: number; maxFinished?: number } = {}): PaperRow[] {
    const maxOpen = opts.maxOpen ?? 50;
    const maxFinished = opts.maxFinished ?? 30;
    const open: PaperRow[] = [...this.positions]
      .sort((a, b) => b.openedAt - a.openedAt)
      .slice(0, maxOpen)
      .map(p => ({
        id: p.id,
        strategy: p.strategy,
        market: p.market,
        outcome: p.outcome,
        wallet: p.wallet,
        size: p.size,
        costUsd: p.costUsd,
        entryPrice: p.costUsd / p.size,
        openedAt: p.openedAt,
        status: 'open' as const,
      }));
    const done = [...this.finished]
      .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
      .slice(0, maxFinished);
    return [...open, ...done];
  }

  /** Drop all OPEN positions (e.g. when switching to LIVE — paper positions are not real). History is kept. */
  clear(): PaperPosition[] {
    const dropped = this.positions;
    this.positions = [];
    return dropped;
  }

  /** Serializable snapshot (see restore). */
  toJSON(): PaperLedgerSnapshot {
    return { version: 1, seq: this.seq, open: this.positions.map(p => ({ ...p })), finished: this.finished.map(r => ({ ...r })) };
  }

  /**
   * Replace this ledger's contents with a previously saved snapshot. Tolerant
   * by design: anything malformed (wrong version, bad rows, not an object)
   * is skipped, never thrown, so a corrupt file cannot stop the bot. Returns
   * how many rows were restored.
   */
  restore(data: unknown): { open: number; finished: number } {
    this.positions = [];
    this.finished = [];
    this.seq = 0;
    if (!data || typeof data !== 'object') return { open: 0, finished: 0 };
    const d = data as Partial<PaperLedgerSnapshot>;
    if (d.version !== 1) return { open: 0, finished: 0 };

    this.positions = (Array.isArray(d.open) ? d.open : []).filter(isValidPosition).map(p => ({ ...p }));
    this.finished = (Array.isArray(d.finished) ? d.finished : []).filter(isValidRow).map(r => ({ ...r })).slice(-MAX_FINISHED);

    // Keep new ids unique: continue after the highest id seen anywhere.
    const highest = Math.max(
      0,
      ...this.positions.map(p => idNumber(p.id)),
      ...this.finished.map(r => idNumber(r.id)),
    );
    this.seq = Math.max(isFiniteNum(d.seq) ? d.seq : 0, highest);
    return { open: this.positions.length, finished: this.finished.length };
  }

  private pushFinished(row: PaperRow) {
    this.finished.push(row);
    if (this.finished.length > MAX_FINISHED) this.finished.splice(0, this.finished.length - MAX_FINISHED);
  }
}

/** Minimal market shape needed to decide resolution (subset of UnifiedMarket). */
export interface ResolvableMarket {
  closed?: boolean;
  tokens: ReadonlyArray<{ tokenId: string; price?: number; winner?: boolean }>;
}

/**
 * Final per-share payout for each token, or null when the market has not
 * clearly resolved.
 *
 * 1. Any token flagged `winner` -> winners pay 1, the rest 0.
 * 2. Otherwise, only for a `closed` market, a decisive final price
 *    (one token >= 0.99, all others <= 0.01) is treated as the result.
 * 3. Anything else (still trading, closed-but-undecided, voided 50/50)
 *    -> null: leave positions open instead of inventing a payout.
 */
export function payoutsFromMarket(market: ResolvableMarket): Map<string, number> | null {
  const tokens = market.tokens.filter(t => t.tokenId);
  if (tokens.length === 0) return null;

  if (tokens.some(t => t.winner === true)) {
    return new Map(tokens.map(t => [t.tokenId, t.winner === true ? 1 : 0]));
  }

  if (!market.closed) return null;
  const prices = tokens.map(t => t.price);
  if (prices.some(p => typeof p !== 'number' || !Number.isFinite(p))) return null;
  const nums = prices as number[];
  const hi = nums.filter(p => p >= 0.99);
  const lo = nums.filter(p => p <= 0.01);
  if (hi.length === 1 && lo.length === nums.length - 1) {
    return new Map(tokens.map((t, i) => [t.tokenId, nums[i] >= 0.99 ? 1 : 0]));
  }
  return null;
}
