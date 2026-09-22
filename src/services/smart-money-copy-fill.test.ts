import { describe, it, expect, vi, afterEach } from 'vitest';
import { SmartMoneyService } from './smart-money-service.js';
import type { CopyFill, SmartMoneyTrade } from './smart-money-service.js';
import type { ActivityTrade } from './realtime-service-v2.js';

/**
 * Regression: the dashboard's "Sim Volume" summed the WHALE's notional
 * (trade.size * trade.price), so a $2,857 whale print on a $50 paper account
 * showed thousands of dollars of "volume". onTrade now also receives the
 * `copy` we actually sized to, and that is what callers must account with.
 */

const WHALE = '0xAbC0000000000000000000000000000000000001';

function setup(options: { sizeScale: number; maxSizePerTrade: number }) {
  let activityHandler: ((t: ActivityTrade) => void) | undefined;
  const realtime = {
    subscribeAllActivity: (h: { onTrade: (t: ActivityTrade) => void }) => {
      activityHandler = h.onTrade;
      return { id: 'sub', unsubscribe: () => {} };
    },
  };
  // No leaderboard is consulted: targetAddresses are explicit.
  const service = new SmartMoneyService({} as any, realtime as any, {} as any);
  const calls: Array<{ trade: SmartMoneyTrade; copy: CopyFill }> = [];

  const started = service.startAutoCopyTrading({
    targetAddresses: [WHALE],
    dryRun: true,
    sizeScale: options.sizeScale,
    maxSizePerTrade: options.maxSizePerTrade,
    minTradeSize: 10,
    maxSlippage: 0.03,
    onTrade: (trade, result, copy) => {
      if (result.success) calls.push({ trade, copy });
    },
  });

  const emit = async (size: number, price: number, side: 'BUY' | 'SELL' = 'BUY') => {
    await started;
    activityHandler!({
      asset: '0xtoken',
      conditionId: '0xcond',
      eventSlug: 'btc-updown-5m',
      marketSlug: 'btc-updown-5m-1',
      outcome: 'Up',
      price,
      side,
      size,
      timestamp: Date.now(),
      transactionHash: '0xhash',
      trader: { address: WHALE },
    });
  };

  return { calls, emit };
}

describe('SmartMoneyService copy accounting (onTrade `copy` argument)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports OUR capped copy, not the whale notional (the Sim Volume bug)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { calls, emit } = setup({ sizeScale: 0.1, maxSizePerTrade: 1 });

    // Whale: 10,000 shares @ 0.2857 ≈ $2,857 notional.
    await emit(10_000, 0.2857);
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const { trade, copy } = calls[0];
    expect(trade.size * trade.price).toBeGreaterThan(2_800); // what the old card summed
    expect(copy.usdcAmount).toBe(1); // capped by maxSizePerTrade
    expect(copy.size).toBeCloseTo(1 / 0.2857, 6);
    // Priced with slippage on top of the whale print (no live quote attached).
    expect(copy.price).toBeCloseTo(0.2857 * 1.03, 6);
  });

  it('reports the scaled notional when under the cap', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { calls, emit } = setup({ sizeScale: 0.1, maxSizePerTrade: 15 });

    await emit(100, 0.5); // whale $50 -> 10% = $5
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    expect(calls[0].copy.usdcAmount).toBeCloseTo(5, 10);
    expect(calls[0].copy.size).toBeCloseTo(10, 10);
  });
});
