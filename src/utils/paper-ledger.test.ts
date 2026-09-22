import { describe, it, expect } from 'vitest';
import { PaperLedger, payoutsFromMarket } from './paper-ledger.js';

const base = {
  strategy: 'smartMoney' as const,
  conditionId: '0xCOND1',
  market: 'btc-updown-5m-1',
  openedAt: 1000,
};

describe('PaperLedger.open', () => {
  it('records a valid entry', () => {
    const l = new PaperLedger();
    const p = l.open({ ...base, tokenId: 'A', size: 3.5, costUsd: 1 });
    expect(p?.id).toBe('paper-1');
    expect(l.openCount()).toBe(1);
    expect(l.openCostUsd()).toBeCloseTo(1, 10);
  });

  it.each([
    ['zero size', { size: 0, costUsd: 1 }],
    ['negative cost', { size: 1, costUsd: -1 }],
    ['NaN size', { size: NaN, costUsd: 1 }],
    ['Infinity cost', { size: 1, costUsd: Infinity }],
  ])('rejects %s', (_n, bad) => {
    const l = new PaperLedger();
    expect(l.open({ ...base, tokenId: 'A', ...bad })).toBeNull();
    expect(l.openCount()).toBe(0);
  });

  it('rejects a missing token or condition id', () => {
    const l = new PaperLedger();
    expect(l.open({ ...base, tokenId: '', size: 1, costUsd: 1 })).toBeNull();
    expect(l.open({ ...base, conditionId: '', tokenId: 'A', size: 1, costUsd: 1 })).toBeNull();
  });
});

describe('PaperLedger.settleMarket', () => {
  it('a winning copy pays $1/share and books the profit', () => {
    const l = new PaperLedger();
    // $1 spent on 3.5 shares (~0.2857/share): wins -> $3.50 payout, +$2.50.
    l.open({ ...base, tokenId: 'UP', size: 3.5, costUsd: 1 });
    const [s] = l.settleMarket('0xcond1', new Map([['UP', 1], ['DOWN', 0]]));
    expect(s.won).toBe(true);
    expect(s.payoutUsd).toBeCloseTo(3.5, 10);
    expect(s.pnlUsd).toBeCloseTo(2.5, 10);
    expect(l.openCount()).toBe(0);
  });

  it('a losing copy loses its whole cost', () => {
    const l = new PaperLedger();
    l.open({ ...base, tokenId: 'UP', size: 3.5, costUsd: 1 });
    const [s] = l.settleMarket('0xCOND1', new Map([['UP', 0], ['DOWN', 1]]));
    expect(s.won).toBe(false);
    expect(s.payoutUsd).toBe(0);
    expect(s.pnlUsd).toBeCloseTo(-1, 10);
  });

  it('only settles the resolved market; others stay open', () => {
    const l = new PaperLedger();
    l.open({ ...base, tokenId: 'UP', size: 2, costUsd: 1 });
    l.open({ ...base, conditionId: '0xOTHER', tokenId: 'X', size: 2, costUsd: 1 });
    const settled = l.settleMarket('0xCOND1', new Map([['UP', 1]]));
    expect(settled).toHaveLength(1);
    expect(l.openCount()).toBe(1);
    expect(l.conditionIds()).toEqual(['0xOTHER']);
  });

  it('leaves a position open when its token is missing from the payouts', () => {
    const l = new PaperLedger();
    l.open({ ...base, tokenId: 'UP', size: 2, costUsd: 1 });
    expect(l.settleMarket('0xCOND1', new Map([['SOMETHING_ELSE', 1]]))).toEqual([]);
    expect(l.openCount()).toBe(1);
  });

  it('matches token ids case-insensitively', () => {
    const l = new PaperLedger();
    l.open({ ...base, tokenId: '0xAbC', size: 2, costUsd: 1 });
    expect(l.settleMarket('0xcond1', new Map([['0xabc', 1]]))).toHaveLength(1);
  });

  it('settles several lots of the same token independently', () => {
    const l = new PaperLedger();
    l.open({ ...base, tokenId: 'UP', size: 2, costUsd: 1 });
    l.open({ ...base, tokenId: 'UP', size: 4, costUsd: 1 });
    const settled = l.settleMarket('0xCOND1', new Map([['UP', 1]]));
    expect(settled.map(s => s.pnlUsd)).toEqual([1, 3]);
  });

  it('settling twice never double-books', () => {
    const l = new PaperLedger();
    l.open({ ...base, tokenId: 'UP', size: 2, costUsd: 1 });
    const payouts = new Map([['UP', 1]]);
    expect(l.settleMarket('0xCOND1', payouts)).toHaveLength(1);
    expect(l.settleMarket('0xCOND1', payouts)).toHaveLength(0);
  });
});

describe('PaperLedger.reduce (a followed wallet sold)', () => {
  it('shrinks size and cost pro rata, then only the remainder settles', () => {
    const l = new PaperLedger();
    l.open({ ...base, tokenId: 'UP', size: 10, costUsd: 4 });
    const released = l.reduce('UP', 4); // close 40%
    expect(released).toBeCloseTo(1.6, 10);
    expect(l.openCostUsd()).toBeCloseTo(2.4, 10);
    const [s] = l.settleMarket('0xCOND1', new Map([['UP', 1]]));
    expect(s.position.size).toBeCloseTo(6, 10);
    expect(s.payoutUsd).toBeCloseTo(6, 10);
    expect(s.pnlUsd).toBeCloseTo(3.6, 10);
  });

  it('closes oldest lots first and removes emptied ones', () => {
    const l = new PaperLedger();
    l.open({ ...base, tokenId: 'UP', size: 2, costUsd: 1, openedAt: 1 });
    l.open({ ...base, tokenId: 'UP', size: 2, costUsd: 3, openedAt: 2 });
    l.reduce('UP', 3); // all of lot 1 + half of lot 2
    expect(l.openCount()).toBe(1);
    expect(l.openCostUsd()).toBeCloseTo(1.5, 10);
  });

  it('is a no-op for an unknown token, zero or negative size', () => {
    const l = new PaperLedger();
    l.open({ ...base, tokenId: 'UP', size: 2, costUsd: 1 });
    expect(l.reduce('NOPE', 5)).toBe(0);
    expect(l.reduce('UP', 0)).toBe(0);
    expect(l.reduce('UP', -3)).toBe(0);
    expect(l.openCount()).toBe(1);
  });

  it('cannot release more than is held', () => {
    const l = new PaperLedger();
    l.open({ ...base, tokenId: 'UP', size: 2, costUsd: 1 });
    expect(l.reduce('UP', 100)).toBeCloseTo(1, 10);
    expect(l.openCount()).toBe(0);
  });
});

describe('PaperLedger bookkeeping', () => {
  it('conditionIds is distinct, oldest first, and limitable', () => {
    const l = new PaperLedger();
    l.open({ ...base, conditionId: '0xB', tokenId: 'b', size: 1, costUsd: 1, openedAt: 20 });
    l.open({ ...base, conditionId: '0xA', tokenId: 'a', size: 1, costUsd: 1, openedAt: 10 });
    l.open({ ...base, conditionId: '0xa', tokenId: 'a2', size: 1, costUsd: 1, openedAt: 30 });
    expect(l.conditionIds()).toEqual(['0xA', '0xB']);
    expect(l.conditionIds(1)).toEqual(['0xA']);
  });

  it('clear drops everything and reports what it dropped', () => {
    const l = new PaperLedger();
    l.open({ ...base, tokenId: 'UP', size: 2, costUsd: 1 });
    expect(l.clear()).toHaveLength(1);
    expect(l.openCount()).toBe(0);
    expect(l.openCostUsd()).toBe(0);
  });
});

describe('payoutsFromMarket', () => {
  it('uses the winner flag when present (even if price data is stale)', () => {
    const m = payoutsFromMarket({
      closed: true,
      tokens: [
        { tokenId: 'UP', price: 0.6, winner: true },
        { tokenId: 'DOWN', price: 0.4, winner: false },
      ],
    });
    expect(m).toEqual(new Map([['UP', 1], ['DOWN', 0]]));
  });

  it('falls back to decisive final prices on a closed market', () => {
    const m = payoutsFromMarket({
      closed: true,
      tokens: [{ tokenId: 'UP', price: 0.001 }, { tokenId: 'DOWN', price: 0.999 }],
    });
    expect(m).toEqual(new Map([['UP', 0], ['DOWN', 1]]));
  });

  it('does NOT settle a market that is still trading, however lopsided', () => {
    expect(payoutsFromMarket({
      closed: false,
      tokens: [{ tokenId: 'UP', price: 0.99 }, { tokenId: 'DOWN', price: 0.01 }],
    })).toBeNull();
  });

  it('does not settle a closed 50/50 (voided or undecided) market', () => {
    expect(payoutsFromMarket({
      closed: true,
      tokens: [{ tokenId: 'UP', price: 0.5 }, { tokenId: 'DOWN', price: 0.5 }],
    })).toBeNull();
  });

  it('does not settle a closed market with a merely likely favourite', () => {
    expect(payoutsFromMarket({
      closed: true,
      tokens: [{ tokenId: 'UP', price: 0.9 }, { tokenId: 'DOWN', price: 0.1 }],
    })).toBeNull();
  });

  it('returns null on missing prices or no tokens', () => {
    expect(payoutsFromMarket({ closed: true, tokens: [{ tokenId: 'UP' }, { tokenId: 'DOWN' }] })).toBeNull();
    expect(payoutsFromMarket({ closed: true, tokens: [] })).toBeNull();
    expect(payoutsFromMarket({ closed: true, tokens: [{ tokenId: 'UP', price: NaN }, { tokenId: 'DOWN', price: 1 }] })).toBeNull();
  });
});
