import { describe, it, expect, vi, afterEach } from 'vitest';
import { SmartMoneyService } from './smart-money-service.js';
import type { CopySkipReason, SmartMoneyTrade } from './smart-money-service.js';
import type { ActivityTrade } from './realtime-service-v2.js';

/**
 * Regression for "I see many 'Copy trade signal' logs but nothing is copied":
 *  1. The signal feed subscribed with NO filter and, because the shared
 *     activity subscription was bound to the first subscriber's options, every
 *     trade on Polymarket was treated as a followed-wallet signal.
 *  2. Non-copies were silent. Every skip now carries a reason.
 */

const FOLLOWED = '0xf011000000000000000000000000000000000001';
const OTHER = '0x0777000000000000000000000000000000000002';
const STRANGER = '0x5757000000000000000000000000000000000003';

function makeService(marketService?: unknown, tradingService: unknown = {}) {
  let feed: ((t: ActivityTrade) => void) | undefined;
  const realtime = {
    subscribeAllActivity: (h: { onTrade: (t: ActivityTrade) => void }) => {
      feed = h.onTrade;
      return { id: 'sub', unsubscribe: () => {} };
    },
  };
  const svc = new SmartMoneyService({} as any, realtime as any, tradingService as any);
  if (marketService) svc.setMarketService(marketService as any);

  const emit = (who: string, o: { size?: number; price?: number; ageMs?: number; side?: 'BUY' | 'SELL'; asset?: string } = {}) =>
    feed!({
      asset: o.asset ?? '0xtok',
      conditionId: '0xcond',
      eventSlug: 'e',
      marketSlug: 'btc-updown-5m',
      outcome: 'Up',
      price: o.price ?? 0.5,
      side: o.side ?? 'BUY',
      size: o.size ?? 100,
      timestamp: Date.now() - (o.ageMs ?? 0),
      transactionHash: '0xh',
      trader: { address: who },
    });
  const settle = () => new Promise(r => setTimeout(r, 25));
  return { svc, emit, settle };
}

const quiet = () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
};

describe('subscribeSmartMoneyTrades: filters are per handler', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a filtered subscriber only sees its wallets, even when an UNFILTERED one subscribed first (the bug)', async () => {
    quiet();
    const { svc, emit, settle } = makeService();
    const unfiltered: string[] = [];
    const filtered: string[] = [];
    svc.subscribeSmartMoneyTrades(t => { unfiltered.push(t.traderAddress); });
    svc.subscribeSmartMoneyTrades(t => { filtered.push(t.traderAddress); }, { filterAddresses: [FOLLOWED] });

    emit(FOLLOWED);
    emit(STRANGER);
    await settle();

    expect(unfiltered).toEqual([FOLLOWED, STRANGER]);
    expect(filtered).toEqual([FOLLOWED]); // before the fix this also contained STRANGER
  });

  it('a later unfiltered subscriber is not narrowed by an earlier filtered one', async () => {
    quiet();
    const { svc, emit, settle } = makeService();
    const narrow: string[] = [];
    const wide: string[] = [];
    svc.subscribeSmartMoneyTrades(t => { narrow.push(t.traderAddress); }, { filterAddresses: [FOLLOWED] });
    svc.subscribeSmartMoneyTrades(t => { wide.push(t.traderAddress); });

    emit(FOLLOWED);
    emit(STRANGER);
    await settle();

    expect(narrow).toEqual([FOLLOWED]);
    expect(wide).toEqual([FOLLOWED, STRANGER]);
  });

  it('applies minSize per handler and matches addresses case-insensitively', async () => {
    quiet();
    const { svc, emit, settle } = makeService();
    const seen: number[] = [];
    svc.subscribeSmartMoneyTrades(t => { seen.push(t.size); }, { filterAddresses: [FOLLOWED.toUpperCase().replace('0X', '0x')], minSize: 50 });

    emit(FOLLOWED, { size: 10 });
    emit(FOLLOWED, { size: 80 });
    await settle();

    expect(seen).toEqual([80]);
  });

  it('keeps feeding remaining handlers after one unsubscribes', async () => {
    quiet();
    const { svc, emit, settle } = makeService();
    const a: string[] = [];
    const b: string[] = [];
    const subA = svc.subscribeSmartMoneyTrades(t => { a.push(t.traderAddress); });
    svc.subscribeSmartMoneyTrades(t => { b.push(t.traderAddress); }, { filterAddresses: [OTHER] });
    subA.unsubscribe();

    emit(OTHER);
    await settle();

    expect(a).toEqual([]);
    expect(b).toEqual([OTHER]);
  });
});

describe('startAutoCopyTrading: every skip has a reason', () => {
  afterEach(() => vi.restoreAllMocks());

  async function run(
    opts: Partial<Parameters<SmartMoneyService['startAutoCopyTrading']>[0]>,
    marketService?: unknown,
    tradingService?: unknown,
  ) {
    const { svc, emit, settle } = makeService(marketService, tradingService);
    const skips: Array<{ reason: CopySkipReason; detail?: string; trade: SmartMoneyTrade }> = [];
    const copied: SmartMoneyTrade[] = [];
    const sub = await svc.startAutoCopyTrading({
      targetAddresses: [FOLLOWED],
      dryRun: true,
      sizeScale: 0.1,
      maxSizePerTrade: 15,
      minTradeSize: 10,
      maxSlippage: 0.03,
      onTrade: (t, r) => { if (r.success) copied.push(t); },
      onSkip: (trade, reason, detail) => { skips.push({ reason, detail, trade }); },
      ...opts,
    });
    return { sub, emit, settle, skips, copied };
  }

  it('classifies small, stale and copied trades, and ignores strangers silently', async () => {
    quiet();
    const { sub, emit, settle, skips, copied } = await run({});

    emit(STRANGER, { size: 500 });                 // not followed -> not counted at all
    emit(FOLLOWED, { size: 5, price: 0.3 });       // $1.50  -> below_min_value
    emit(FOLLOWED, { ageMs: 30_000 });             // $50 but 30s old -> stale
    emit(FOLLOWED);                                // $50 fresh -> copied
    await settle();

    expect(copied).toHaveLength(1);
    expect(skips.map(s => s.reason)).toEqual(['below_min_value', 'stale']);
    expect(skips[0].detail).toContain('$1.50');
    expect(skips[1].detail).toContain('30.0s old');

    const s = sub.getStats();
    expect(s.tradesDetected).toBe(3); // the stranger never reaches the engine
    expect(s.tradesExecuted).toBe(1);
    expect(s.tradesSkipped).toBe(2);
    expect(s.skipReasons.below_min_value).toBe(1);
    expect(s.skipReasons.stale).toBe(1);
    expect(s.staleSkipped).toBe(1); // legacy counter still maintained
  });

  it('skipReasons always sum to tradesSkipped', async () => {
    quiet();
    const { sub, emit, settle } = await run({ sideFilter: 'BUY' });

    emit(FOLLOWED, { size: 5, price: 0.3 });                 // below_min_value
    emit(FOLLOWED, { side: 'SELL' });                        // side_filter
    emit(FOLLOWED, { ageMs: 60_000 });                       // stale
    emit(FOLLOWED, { asset: '' });                           // no_token
    emit(FOLLOWED);                                          // copied
    await settle();

    const s = sub.getStats();
    const sum = Object.values(s.skipReasons).reduce((a, b) => a + b, 0);
    expect(sum).toBe(s.tradesSkipped);
    expect(s.skipReasons).toMatchObject({ below_min_value: 1, side_filter: 1, stale: 1, no_token: 1 });
    expect(s.tradesExecuted).toBe(1);
  });

  it('flags a copy that scales below the $1 minimum order', async () => {
    quiet();
    const { skips, emit, settle } = await run({ sizeScale: 0.01 }); // whale $50 -> copy $0.50
    emit(FOLLOWED);
    await settle();
    expect(skips.map(s => s.reason)).toEqual(['below_min_order']);
    expect(skips[0].detail).toContain('$0.50');
  });

  it('reports the risk guard reason', async () => {
    quiet();
    const { skips, emit, settle, copied } = await run({ preExecutionGuard: () => 'daily loss limit hit' });
    emit(FOLLOWED);
    await settle();
    expect(copied).toHaveLength(0);
    expect(skips).toMatchObject([{ reason: 'risk_guard', detail: 'daily loss limit hit' }]);
  });

  describe('live quote guard says WHICH check failed', () => {
    const market = (asks: Array<{ price: number; size: number }>, bids: Array<{ price: number; size: number }>) => ({
      getTokenOrderbook: async () => ({ asks, bids }),
    });

    it('wide spread', async () => {
      quiet();
      // spread (0.6-0.4)/0.6 = 33% > 2%; ask 0.6 vs whale 0.5 is +20% too, so
      // BOTH failures are reported, spread first.
      const { skips, emit, settle } = await run({}, market([{ price: 0.6, size: 1000 }], [{ price: 0.4, size: 1000 }]));
      emit(FOLLOWED);
      await settle();
      expect(skips[0].reason).toBe('quote_guard');
      expect(skips[0].detail).toMatch(/^spread 33\.3% > 2%; market already moved 20\.0%/);
    });

    it('reports a spread failure on its own when the price has not moved', async () => {
      quiet();
      // whale 0.50; bid 0.44 / ask 0.50 -> spread 12%, premium 0%
      const { skips, emit, settle } = await run({}, market([{ price: 0.5, size: 1000 }], [{ price: 0.44, size: 1000 }]));
      emit(FOLLOWED);
      await settle();
      expect(skips[0].reason).toBe('quote_guard');
      expect(skips[0].detail).toBe('spread 12.0% > 2%');
    });

    it('market already ran past the whale', async () => {
      quiet();
      // tight spread (~1%), but ask 0.51 vs whale 0.50 = +2% premium (> 1%)
      const { skips, emit, settle } = await run({}, market([{ price: 0.51, size: 1000 }], [{ price: 0.505, size: 1000 }]));
      emit(FOLLOWED);
      await settle();
      expect(skips[0].reason).toBe('quote_guard');
      expect(skips[0].detail).toContain('already moved');
    });

    it('not enough size at the top of the book', async () => {
      quiet();
      const { skips, emit, settle } = await run({}, market([{ price: 0.5, size: 0.1 }], [{ price: 0.499, size: 1000 }]));
      emit(FOLLOWED);
      await settle();
      expect(skips[0].reason).toBe('quote_guard');
      expect(skips[0].detail).toContain('top-of-book');
    });
  });

  it('pauses a wallet after repeated failures and says so (wallet_cooldown)', async () => {
    quiet();
    const failing = { createMarketOrder: async () => ({ success: false, errorMsg: 'rejected' }) };
    const { skips, emit, settle, sub } = await run({ dryRun: false, maxConsecutiveFailures: 3 }, undefined, failing);

    // One at a time, like real trades: the breaker is checked when a trade
    // arrives, so a simultaneous burst would all pass it before any failure lands.
    for (let i = 0; i < 4; i++) {
      emit(FOLLOWED);
      await settle();
    }

    expect(sub.getStats().tradesFailed).toBe(3);
    expect(skips.map(s => s.reason)).toEqual(['wallet_cooldown']);
    expect(skips[0].detail).toContain('circuit breaker');
  });

  it('a throwing onSkip callback never breaks copying', async () => {
    quiet();
    const { sub, emit, settle, copied } = await run({ onSkip: () => { throw new Error('logger down'); } });
    emit(FOLLOWED, { size: 5, price: 0.3 }); // skipped -> onSkip throws
    emit(FOLLOWED);                          // must still be copied
    await settle();
    expect(copied).toHaveLength(1);
    expect(sub.getStats().skipReasons.below_min_value).toBe(1);
  });

  it('getStats returns a snapshot, not the live counters', async () => {
    quiet();
    const { sub, emit, settle } = await run({});
    const before = sub.getStats();
    emit(FOLLOWED, { size: 5, price: 0.3 });
    await settle();
    expect(before.skipReasons.below_min_value).toBe(0);
    expect(sub.getStats().skipReasons.below_min_value).toBe(1);
  });
});
