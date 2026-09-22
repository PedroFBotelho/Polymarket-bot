import { describe, it, expect } from 'vitest';
import { PaperLedger } from './paper-ledger.js';

const WHALE = '0xf011000000000000000000000000000000000001';
const base = {
  strategy: 'smartMoney' as const,
  conditionId: '0xCOND1',
  market: 'btc-updown-5m-1',
  outcome: 'Up',
  wallet: WHALE,
  openedAt: 1_000,
};

describe('rows(): what the dashboard table shows', () => {
  it('lists an open position with its entry price and copied wallet', () => {
    const l = new PaperLedger();
    l.open({ ...base, tokenId: 'UP', size: 4, costUsd: 1 });
    const [row] = l.rows();
    expect(row).toMatchObject({
      status: 'open',
      market: 'btc-updown-5m-1',
      outcome: 'Up',
      wallet: WHALE,
      size: 4,
      costUsd: 1,
      entryPrice: 0.25,
    });
    expect(row.closedAt).toBeUndefined();
    expect(row.pnlUsd).toBeUndefined();
  });

  it('turns a settled position into a won/lost row with payout and PnL', () => {
    const l = new PaperLedger();
    l.open({ ...base, tokenId: 'UP', size: 4, costUsd: 1 });
    l.open({ ...base, conditionId: '0xCOND2', market: 'btc-updown-5m-2', tokenId: 'X', size: 2, costUsd: 1 });
    l.settleMarket('0xCOND1', new Map([['UP', 1]]), 5_000);
    l.settleMarket('0xCOND2', new Map([['X', 0]]), 6_000);

    const rows = l.rows();
    const won = rows.find(r => r.market === 'btc-updown-5m-1')!;
    const lost = rows.find(r => r.market === 'btc-updown-5m-2')!;
    expect(won).toMatchObject({ status: 'won', closedAt: 5_000, payoutUsd: 4, pnlUsd: 3 });
    expect(lost).toMatchObject({ status: 'lost', closedAt: 6_000, payoutUsd: 0, pnlUsd: -1 });
  });

  it('orders open rows newest-first, then finished rows newest-first', () => {
    const l = new PaperLedger();
    l.open({ ...base, conditionId: '0xA', market: 'old-open', tokenId: 'a', size: 1, costUsd: 1, openedAt: 10 });
    l.open({ ...base, conditionId: '0xB', market: 'new-open', tokenId: 'b', size: 1, costUsd: 1, openedAt: 20 });
    l.open({ ...base, conditionId: '0xC', market: 'done-early', tokenId: 'c', size: 1, costUsd: 1, openedAt: 5 });
    l.open({ ...base, conditionId: '0xD', market: 'done-late', tokenId: 'd', size: 1, costUsd: 1, openedAt: 6 });
    l.settleMarket('0xC', new Map([['c', 1]]), 100);
    l.settleMarket('0xD', new Map([['d', 1]]), 200);

    expect(l.rows().map(r => r.market)).toEqual(['new-open', 'old-open', 'done-late', 'done-early']);
  });

  it('caps open and finished rows independently', () => {
    const l = new PaperLedger();
    for (let i = 0; i < 5; i++) l.open({ ...base, conditionId: `0xO${i}`, market: `open-${i}`, tokenId: `o${i}`, size: 1, costUsd: 1, openedAt: i });
    for (let i = 0; i < 5; i++) {
      l.open({ ...base, conditionId: `0xF${i}`, market: `fin-${i}`, tokenId: `f${i}`, size: 1, costUsd: 1, openedAt: i });
      l.settleMarket(`0xF${i}`, new Map([[`f${i}`, 1]]), 1_000 + i);
    }
    const rows = l.rows({ maxOpen: 2, maxFinished: 3 });
    expect(rows.filter(r => r.status === 'open')).toHaveLength(2);
    expect(rows.filter(r => r.status !== 'open')).toHaveLength(3);
    // the most recently finished are the ones kept
    expect(rows.filter(r => r.status !== 'open').map(r => r.market)).toEqual(['fin-4', 'fin-3', 'fin-2']);
  });

  it('keeps only the most recent 200 finished rows', () => {
    const l = new PaperLedger();
    for (let i = 0; i < 250; i++) {
      l.open({ ...base, conditionId: `0x${i}`, tokenId: `t${i}`, size: 1, costUsd: 1, market: `m${i}` });
      l.settleMarket(`0x${i}`, new Map([[`t${i}`, 1]]), i);
    }
    const snap = l.toJSON();
    expect(snap.finished).toHaveLength(200);
    expect(snap.finished[0].market).toBe('m50'); // oldest 50 dropped
    expect(snap.finished[199].market).toBe('m249');
  });
});

describe('reduce(): a followed wallet sold', () => {
  it('records a closed row per lot, splitting the booked PnL pro rata by shares', () => {
    const l = new PaperLedger();
    l.open({ ...base, tokenId: 'UP', size: 2, costUsd: 1, openedAt: 1 });
    l.open({ ...base, tokenId: 'UP', size: 6, costUsd: 3, openedAt: 2 });
    l.reduce('UP', 8, 4, 9_000); // close everything, booked +$4 in total

    const closed = l.rows().filter(r => r.status === 'closed');
    expect(closed).toHaveLength(2);
    const small = closed.find(r => r.size === 2)!;
    const large = closed.find(r => r.size === 6)!;
    expect(small.pnlUsd).toBeCloseTo(1, 10); // 4 * 2/8
    expect(large.pnlUsd).toBeCloseTo(3, 10); // 4 * 6/8
    expect(small.payoutUsd).toBeCloseTo(2, 10); // cost 1 + pnl 1
    expect(small.closedAt).toBe(9_000);
    expect(l.openCount()).toBe(0);
  });

  it('a partial close leaves the remainder open and records only the closed part', () => {
    const l = new PaperLedger();
    l.open({ ...base, tokenId: 'UP', size: 10, costUsd: 4 });
    l.reduce('UP', 4, -0.5, 7_000);

    const rows = l.rows();
    const open = rows.find(r => r.status === 'open')!;
    const closed = rows.find(r => r.status === 'closed')!;
    expect(open.size).toBeCloseTo(6, 10);
    expect(open.costUsd).toBeCloseTo(2.4, 10);
    expect(closed.size).toBeCloseTo(4, 10);
    expect(closed.costUsd).toBeCloseTo(1.6, 10);
    expect(closed.pnlUsd).toBeCloseTo(-0.5, 10);
    expect(closed.entryPrice).toBeCloseTo(0.4, 10);
  });

  it('without a realized PnL the closed row has none (unknown, not zero)', () => {
    const l = new PaperLedger();
    l.open({ ...base, tokenId: 'UP', size: 2, costUsd: 1 });
    l.reduce('UP', 2);
    const [row] = l.rows();
    expect(row.status).toBe('closed');
    expect(row.pnlUsd).toBeUndefined();
    expect(row.payoutUsd).toBeUndefined();
  });

  it('does nothing (no row) for an unknown token', () => {
    const l = new PaperLedger();
    l.open({ ...base, tokenId: 'UP', size: 2, costUsd: 1 });
    l.reduce('NOPE', 5, 1);
    expect(l.rows().map(r => r.status)).toEqual(['open']);
  });
});

describe('clear(): switching to LIVE', () => {
  it('drops open positions but keeps the history', () => {
    const l = new PaperLedger();
    l.open({ ...base, tokenId: 'A', conditionId: '0xA', size: 1, costUsd: 1 });
    l.open({ ...base, tokenId: 'B', conditionId: '0xB', size: 1, costUsd: 1 });
    l.settleMarket('0xA', new Map([['A', 1]]), 1);
    expect(l.clear()).toHaveLength(1);
    expect(l.openCount()).toBe(0);
    expect(l.rows().map(r => r.status)).toEqual(['won']);
  });
});

describe('toJSON / restore: surviving a restart', () => {
  const populated = () => {
    const l = new PaperLedger();
    l.open({ ...base, tokenId: 'A', conditionId: '0xA', market: 'settled-mkt', size: 4, costUsd: 1, openedAt: 1 });
    l.open({ ...base, tokenId: 'B', conditionId: '0xB', market: 'open-mkt', size: 2, costUsd: 1, openedAt: 2 });
    l.settleMarket('0xA', new Map([['A', 1]]), 50);
    return l;
  };

  it('round-trips open positions and history through JSON', () => {
    const saved = JSON.parse(JSON.stringify(populated().toJSON())); // as if written to disk and read back
    const fresh = new PaperLedger();
    expect(fresh.restore(saved)).toEqual({ open: 1, finished: 1 });
    expect(fresh.openCount()).toBe(1);
    expect(fresh.openCostUsd()).toBeCloseTo(1, 10);
    expect(fresh.rows()).toEqual(populated().rows());
  });

  it('keeps ids unique: new positions continue after the restored ones', () => {
    const saved = JSON.parse(JSON.stringify(populated().toJSON()));
    const fresh = new PaperLedger();
    fresh.restore(saved);
    const next = fresh.open({ ...base, tokenId: 'C', conditionId: '0xC', size: 1, costUsd: 1 });
    expect(next?.id).toBe('paper-3');
    const ids = fresh.rows().map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a restored open position still settles', () => {
    const fresh = new PaperLedger();
    fresh.restore(JSON.parse(JSON.stringify(populated().toJSON())));
    const [s] = fresh.settleMarket('0xB', new Map([['B', 1]]), 99);
    expect(s.pnlUsd).toBeCloseTo(1, 10); // 2 shares * $1 - $1 cost
  });

  it('replaces whatever was in the ledger before', () => {
    const l = new PaperLedger();
    l.open({ ...base, tokenId: 'OLD', conditionId: '0xOLD', size: 1, costUsd: 1 });
    l.restore(JSON.parse(JSON.stringify(populated().toJSON())));
    expect(l.rows().some(r => r.id === 'paper-1' && r.market === 'settled-mkt')).toBe(true);
    expect(l.conditionIds()).toEqual(['0xB']);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'garbage'],
    ['an array', []],
    ['the wrong version', { version: 2, seq: 1, open: [], finished: [] }],
    ['no version', { seq: 1, open: [], finished: [] }],
  ])('restoring %s yields an empty ledger, never throws', (_label, bad) => {
    const l = new PaperLedger();
    l.open({ ...base, tokenId: 'X', size: 1, costUsd: 1 });
    expect(l.restore(bad)).toEqual({ open: 0, finished: 0 });
    expect(l.rows()).toEqual([]);
  });

  it('skips malformed rows but keeps the valid ones', () => {
    const good = populated().toJSON();
    const corrupted = {
      ...good,
      open: [
        ...good.open,
        { id: 'paper-9', strategy: 'smartMoney', tokenId: 'Z', conditionId: '0xZ', market: 'm', size: -1, costUsd: 1, openedAt: 1 }, // negative size
        { id: 'paper-10', strategy: 'nope', tokenId: 'Z', conditionId: '0xZ', market: 'm', size: 1, costUsd: 1, openedAt: 1 },        // bad strategy
        'not an object',
        null,
      ],
      finished: [...good.finished, { id: 'x' }, 42],
    };
    const l = new PaperLedger();
    expect(l.restore(JSON.parse(JSON.stringify(corrupted)))).toEqual({ open: 1, finished: 1 });
  });

  it('tolerates non-array open/finished fields', () => {
    const l = new PaperLedger();
    expect(l.restore({ version: 1, seq: 4, open: 'x', finished: {} })).toEqual({ open: 0, finished: 0 });
    // seq is still honoured so ids never restart below what was used
    expect(l.open({ ...base, tokenId: 'A', size: 1, costUsd: 1 })?.id).toBe('paper-5');
  });

  it('a seq lower than the ids on disk cannot cause an id collision', () => {
    const snap = populated().toJSON();
    snap.seq = 0;
    const l = new PaperLedger();
    l.restore(JSON.parse(JSON.stringify(snap)));
    expect(l.open({ ...base, tokenId: 'C', conditionId: '0xC', size: 1, costUsd: 1 })?.id).toBe('paper-3');
  });

  it('toJSON returns a copy: mutating it does not change the ledger', () => {
    const l = populated();
    const snap = l.toJSON();
    snap.open[0].size = 9999;
    snap.finished.length = 0;
    expect(l.openCount()).toBe(1);
    expect(l.rows().find(r => r.status === 'open')!.size).toBe(2);
    expect(l.rows().some(r => r.status === 'won')).toBe(true);
  });
});
