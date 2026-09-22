#!/usr/bin/env npx tsx
/**
 * Withdraw / sweep funds OUT of a wallet, to any address.
 *
 * The key stays only in this process's environment — it is never passed as a
 * CLI argument (would land in shell history / `ps`), only via PRIVATE_KEY.
 *
 * Usage:
 *   PRIVATE_KEY=0x... npx tsx scripts/wallet/withdraw.ts <token> <to> <amount>
 *   PRIVATE_KEY=0x... npx tsx scripts/wallet/withdraw.ts <token> <to> all
 *
 * token: matic | usdc | usdce
 * amount: a plain number, or "all" to sweep the full balance (minus, for
 *         MATIC, a small amount reserved for this transaction's own gas).
 *
 * Examples:
 *   PRIVATE_KEY=0x... npx tsx scripts/wallet/withdraw.ts usdce 0xDEST... all
 *   PRIVATE_KEY=0x... npx tsx scripts/wallet/withdraw.ts matic 0xDEST... 0.5
 */

import { OnchainService } from '../../src/index.js';
import { ethers } from 'ethers';

const PRIVATE_KEY = process.env.PRIVATE_KEY || '';
const GAS_RESERVE_MATIC = '0.05'; // left behind when sweeping "all" MATIC, to cover this tx's own gas

async function main() {
  const [tokenArg, to, amountArg] = process.argv.slice(2);

  if (!PRIVATE_KEY || !tokenArg || !to || !amountArg) {
    console.log('Usage: PRIVATE_KEY=0x... npx tsx scripts/wallet/withdraw.ts <matic|usdc|usdce> <to> <amount|all>');
    process.exit(1);
  }
  if (!ethers.utils.isAddress(to)) {
    console.error(`Not a valid address: ${to}`);
    process.exit(1);
  }

  const token = tokenArg.toLowerCase();
  const onchain = new OnchainService({ privateKey: PRIVATE_KEY });

  console.log(`\nFrom:  ${onchain.getAddress()}`);
  console.log(`To:    ${to}`);

  let result;
  if (token === 'matic') {
    const balance = await onchain.getMaticBalance();
    const amount = amountArg === 'all'
      ? Math.max(0, parseFloat(balance) - parseFloat(GAS_RESERVE_MATIC)).toString()
      : amountArg;
    console.log(`Amount: ${amount} MATIC (balance: ${balance})`);
    result = await onchain.transferMatic(to, amount);
  } else if (token === 'usdce') {
    const balances = await onchain.getTokenBalances();
    const amount = amountArg === 'all' ? balances.usdcE : amountArg;
    console.log(`Amount: ${amount} USDC.e (balance: ${balances.usdcE})`);
    result = await onchain.transferUsdcE(to, amount);
  } else if (token === 'usdc') {
    const balances = await onchain.getTokenBalances();
    const amount = amountArg === 'all' ? balances.usdc : amountArg;
    console.log(`Amount: ${amount} native USDC (balance: ${balances.usdc})`);
    result = await onchain.transferUsdc(to, amount);
  } else {
    console.error(`Unknown token "${tokenArg}" — use matic, usdc, or usdce`);
    process.exit(1);
  }

  console.log(`\n${result.success ? '✅' : '❌'} tx: ${result.transactionHash}`);
  console.log(`   https://polygonscan.com/tx/${result.transactionHash}`);
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
