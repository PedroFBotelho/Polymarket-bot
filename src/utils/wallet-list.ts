/**
 * Parse a user-supplied list of wallet addresses (e.g. the CUSTOM_WALLETS env
 * var) into a clean, deduplicated list.
 *
 * Accepts commas, semicolons, spaces and newlines as separators. Addresses are
 * lowercased (the rest of the bot compares them lowercase). Anything that is
 * not a 0x + 40-hex address is returned in `invalid` instead of being silently
 * dropped, so the caller can tell the user their config has a typo.
 */

export interface WalletList {
  /** Valid, lowercased, deduplicated, in the order given. */
  wallets: string[];
  /** Entries that were not valid addresses, as written. */
  invalid: string[];
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export function parseWalletList(raw: string | undefined | null): WalletList {
  const wallets: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const entry of (raw ?? '').split(/[\s,;]+/)) {
    if (!entry) continue;
    if (!ADDRESS_RE.test(entry)) {
      invalid.push(entry);
      continue;
    }
    const address = entry.toLowerCase();
    if (seen.has(address)) continue;
    seen.add(address);
    wallets.push(address);
  }

  return { wallets, invalid };
}
