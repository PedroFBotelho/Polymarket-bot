import { describe, it, expect } from 'vitest';
import { parseWalletList } from './wallet-list.js';

const A = '0xc2e7800b5af46e6093872b177b7a5e7f0563be51';
const B = '0x58c3f5d66c95d4c41b093fbdd2520e46b6c9de74';

describe('parseWalletList', () => {
  it.each([undefined, null, '', '   ', ',,;\n'])('returns nothing for %j', (raw) => {
    expect(parseWalletList(raw as string | undefined | null)).toEqual({ wallets: [], invalid: [] });
  });

  it('parses a comma-separated list, in order', () => {
    expect(parseWalletList(`${A},${B}`)).toEqual({ wallets: [A, B], invalid: [] });
  });

  it('accepts spaces, newlines, semicolons and a trailing comma', () => {
    expect(parseWalletList(` ${A} ;\n${B},\n`).wallets).toEqual([A, B]);
  });

  it('lowercases mixed-case (checksummed) addresses', () => {
    const checksummed = '0xC2E7800B5AF46E6093872B177B7A5E7F0563BE51';
    expect(parseWalletList(checksummed).wallets).toEqual([A]);
  });

  it('deduplicates case-insensitively, keeping the first position', () => {
    const upper = A.toUpperCase().replace('0X', '0x');
    expect(parseWalletList(`${A},${B},${upper}`).wallets).toEqual([A, B]);
  });

  it.each([
    ['missing 0x prefix', A.slice(2)],
    ['too short', A.slice(0, -1)],
    ['too long', A + 'a'],
    ['non-hex characters', '0x' + 'z'.repeat(40)],
    ['an ENS-style name', 'vitalik.eth'],
  ])('reports %s as invalid instead of dropping it silently', (_label, bad) => {
    expect(parseWalletList(`${A},${bad},${B}`)).toEqual({ wallets: [A, B], invalid: [bad] });
  });

  it('collects every invalid entry, as written', () => {
    expect(parseWalletList('nope, 0x123').invalid).toEqual(['nope', '0x123']);
  });
});
