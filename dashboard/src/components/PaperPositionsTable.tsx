import { useEffect, useState } from 'react';
import type { PaperPositionRow } from '../types';

interface PaperPositionsTableProps {
    rows: PaperPositionRow[];
}

// Status is always shown as text as well as colour.
const STATUS: Record<PaperPositionRow['status'], { label: string; badge: string; hint: string }> = {
    open: { label: 'OPEN', badge: 'badge-blue', hint: 'Waiting for the market to resolve' },
    won: { label: 'WON', badge: 'badge-green', hint: 'The market resolved in our favour' },
    lost: { label: 'LOST', badge: 'badge-red', hint: 'The market resolved against us' },
    closed: { label: 'SOLD', badge: 'badge-yellow', hint: 'Closed because the copied wallet sold' },
};

const money = (v: number) => `$${v.toFixed(2)}`;
const signed = (v: number) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
const shortWallet = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`;

function timeAgo(then: number, now: number): string {
    const s = Math.max(0, Math.round((now - then) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h}h ${m % 60}m ago` : `${Math.floor(h / 24)}d ago`;
}

/**
 * The simulated (paper) trades the bot has made in DRY RUN: which market, which
 * side, what it cost, which followed wallet it copied, and how it ended.
 */
export function PaperPositionsTable({ rows }: PaperPositionsTableProps) {
    // Ages tick even when no new state arrives.
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = window.setInterval(() => setNow(Date.now()), 15_000);
        return () => window.clearInterval(id);
    }, []);

    const open = rows.filter(r => r.status === 'open');
    const finished = rows.filter(r => r.status !== 'open');
    const atRisk = open.reduce((sum, r) => sum + r.costUsd, 0);
    const realized = finished.reduce((sum, r) => sum + (r.pnlUsd ?? 0), 0);
    const won = finished.filter(r => r.status === 'won').length;
    const lost = finished.filter(r => r.status === 'lost').length;

    return (
        <div className="panel animate-fade-in">
            <div className="panel-header">
                <h3 className="section-header mb-0">
                    <div className="section-header-icon bg-gradient-to-br from-cyan-500/20 to-blue-500/20">📝</div>
                    Paper Positions <span className="text-xs text-gray-500 font-normal">(simulated — no real money)</span>
                </h3>
            </div>
            <div className="panel-body">
                <div className="flex flex-wrap gap-x-8 gap-y-2 mb-4 text-sm">
                    <div>
                        <span className="text-gray-500">Open </span>
                        <span className="font-mono font-semibold">{open.length}</span>
                        <span className="text-gray-500"> · at risk </span>
                        <span className="font-mono font-semibold">{money(atRisk)}</span>
                    </div>
                    <div>
                        <span className="text-gray-500">Finished </span>
                        <span className="font-mono font-semibold">{finished.length}</span>
                        <span className="text-gray-500"> · </span>
                        <span className="text-green-400 font-mono">{won} won</span>
                        <span className="text-gray-500"> / </span>
                        <span className="text-red-400 font-mono">{lost} lost</span>
                    </div>
                    <div>
                        <span className="text-gray-500">Realized </span>
                        <span className={`font-mono font-semibold ${realized >= 0 ? 'text-green-400' : 'text-red-400'}`}>{signed(realized)}</span>
                    </div>
                </div>

                <div className="overflow-x-auto">
                    <table className="w-full">
                        <caption className="sr-only">Simulated positions copied by the bot, newest open positions first</caption>
                        <thead>
                            <tr className="border-b border-white/10 text-left text-xs text-gray-500 uppercase tracking-wider">
                                <th scope="col" className="pb-3 pr-4">Status</th>
                                <th scope="col" className="pb-3 pr-4">Market</th>
                                <th scope="col" className="pb-3 pr-4">Side</th>
                                <th scope="col" className="pb-3 pr-4 text-right">Cost</th>
                                <th scope="col" className="pb-3 pr-4 text-right">Entry</th>
                                <th scope="col" className="pb-3 pr-4">Copied wallet</th>
                                <th scope="col" className="pb-3 pr-4">Opened</th>
                                <th scope="col" className="pb-3 text-right">Result</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {rows.map(row => {
                                const s = STATUS[row.status];
                                const up = row.outcome === 'Yes' || row.outcome === 'Up';
                                return (
                                    <tr key={`${row.id}-${row.status}-${row.closedAt ?? ''}`} className="hover:bg-white/5 transition-colors">
                                        <td className="py-3 pr-4">
                                            <span className={`badge ${s.badge}`} title={s.hint}>{s.label}</span>
                                        </td>
                                        <td className="py-3 pr-4">
                                            <div className="max-w-[320px] truncate text-gray-200" title={row.market}>{row.market}</div>
                                            <div className="text-xs text-gray-500">{row.strategy === 'smartMoney' ? 'Smart Money copy' : 'Direct trend'}</div>
                                        </td>
                                        <td className="py-3 pr-4">
                                            {row.outcome ? (
                                                <span className={`badge ${up ? 'badge-green' : 'badge-red'}`}>{row.outcome}</span>
                                            ) : (
                                                <span className="text-gray-500">—</span>
                                            )}
                                        </td>
                                        <td className="py-3 pr-4 text-right font-mono">{money(row.costUsd)}</td>
                                        <td className="py-3 pr-4 text-right font-mono text-gray-400" title={`${row.size.toFixed(2)} shares`}>
                                            ${row.entryPrice.toFixed(3)}
                                        </td>
                                        <td className="py-3 pr-4 font-mono text-gray-400" title={row.wallet}>
                                            {row.wallet ? shortWallet(row.wallet) : '—'}
                                        </td>
                                        <td className="py-3 pr-4 text-gray-400 whitespace-nowrap" title={new Date(row.openedAt).toLocaleString()}>
                                            {timeAgo(row.openedAt, now)}
                                        </td>
                                        <td className="py-3 text-right whitespace-nowrap">
                                            {row.pnlUsd === undefined ? (
                                                <span className="text-gray-500">{row.status === 'open' ? 'pending' : 'n/a'}</span>
                                            ) : (
                                                <span className={`font-mono font-semibold ${row.pnlUsd >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                    {signed(row.pnlUsd)}
                                                </span>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
                <p className="text-xs text-gray-500 mt-3">
                    Positions settle when their market resolves (winning shares pay $1, losing shares $0). Fees are not modelled.
                    Saved to <span className="font-mono">data/paper-positions.json</span>, so open positions survive a restart.
                </p>
            </div>
        </div>
    );
}
