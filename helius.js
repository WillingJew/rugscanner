require('dotenv').config();

function rpcUrl() {
  return process.env.HELIUS_RPC_URL ||
    `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
}

async function rpc(method, params) {
  const res = await fetch(rpcUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params })
  });
  const data = await res.json();
  if (data.error) throw new Error(`Helius RPC error: ${data.error.message}`);
  return data.result;
}

// ── Known DEX program IDs — owners of LP token accounts ──────────────────────
const DEX_PROGRAMS = new Set([
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',  // Orca Whirlpool
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',  // Meteora DLMM
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EkYBZyfx', // Meteora Pools
  'SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ',  // Saber
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', // Orca v2
]);

// ── Burn / null addresses — tokens sent here are permanently locked ───────────
const BURN_ADDRESSES = new Set([
  '1nc1nerator11111111111111111111111111111111',
  'burnX1111111111111111111111111111111111111',
  '0x000000000000000000000000000000000000dEaD', // not Solana but just in case
]);

// ── System addresses that are never real funders ──────────────────────────────
const SYSTEM_ADDRS = new Set([
  '11111111111111111111111111111111',
  'ComputeBudget111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv',
  'SysvarRent111111111111111111111111111111111',
  'SysvarC1ock11111111111111111111111111111111',
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',  // Metaplex
  'TokenzQdBNbEquvqVPTub57KHruzbULMuWAbhs6Uydbe',  // Token-2022
]);

async function getTokenSupply(mint) {
  const result = await rpc('getTokenSupply', [mint]);
  return result?.value?.uiAmount || null;
}

async function getTopHolders(mint) {
  let all = [];
  let cursor = null;
  while (all.length < 5000) {
    const body = {
      jsonrpc: '2.0', id: 'holders', method: 'getTokenAccounts',
      params: { mint, limit: 1000, ...(cursor ? { cursor } : {}) }
    };
    const res = await fetch(rpcUrl(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!data.result?.token_accounts?.length) break;
    all = [...all, ...data.result.token_accounts];
    cursor = data.result.cursor;
    if (!cursor) break;
  }
  return all;
}

async function getAccountProgram(address) {
  try {
    const result = await rpc('getAccountInfo', [address, { encoding: 'base64' }]);
    return result?.value?.owner || null;
  } catch { return null; }
}

async function getSolBalance(address) {
  try {
    const result = await rpc('getBalance', [address]);
    return result?.value != null ? result.value / 1e9 : null;
  } catch { return null; }
}

async function getFunder(address) {
  try {
    const sigs = await rpc('getSignaturesForAddress', [address, { limit: 1000 }]);
    if (!sigs?.length) return null;
    const oldest = sigs[sigs.length - 1].signature;

    const tx = await rpc('getTransaction', [oldest, {
      encoding: 'jsonParsed',
      maxSupportedTransactionVersion: 0
    }]);
    if (!tx) return null;

    const accounts = tx.transaction?.message?.accountKeys || [];
    const pre = tx.meta?.preBalances || [];
    const post = tx.meta?.postBalances || [];

    for (let i = 0; i < accounts.length; i++) {
      const pk = accounts[i]?.pubkey || accounts[i];
      if (!pk || pk === address) continue;
      if (SYSTEM_ADDRS.has(pk)) continue;
      if (DEX_PROGRAMS.has(pk)) continue;
      const decrease = (pre[i] || 0) - (post[i] || 0);
      if (decrease >= 1000000) return pk; // at least 0.001 SOL
    }
    return null;
  } catch { return null; }
}

// ── Core LP detection logic ───────────────────────────────────────────────────
// An account is an LP if:
//   1. Its owner program is a known DEX program, OR
//   2. Its owner address is a known burn address
// We NO LONGER assume rank #1 = LP. That was the bug.
function detectIsLP(ownerAddress, ownerProgram) {
  if (!ownerAddress) return false;
  if (BURN_ADDRESSES.has(ownerAddress)) return true;
  if (DEX_PROGRAMS.has(ownerProgram)) return true;
  return false;
}

async function analyzeToken(mint) {
  console.log('[Helius] Analyzing', mint);

  const [supply, accounts] = await Promise.all([
    getTokenSupply(mint),
    getTopHolders(mint)
  ]);

  if (!supply) throw new Error('Could not fetch token supply. Is this a valid Solana token CA?');
  if (!accounts?.length) throw new Error('No holders found.');

  console.log('[Helius] Supply:', supply, '| Raw accounts:', accounts.length);

  // Sort by amount, take top 30 (extra buffer so we always have 25 real holders after LP removal)
  const top30 = accounts
    .filter(a => a.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 30);

  // Fetch program owners in parallel for all top30
  const programs = await Promise.all(top30.map(a => getAccountProgram(a.owner)));

  // Build holder list with proper LP detection
  const holders = top30.map((account, i) => {
    const owner = account.owner;
    const amount = account.amount / Math.pow(10, account.decimals || 6);
    const pct = Math.round((amount / supply) * 10000) / 100;
    const program = programs[i];
    const isLP = detectIsLP(owner, program);
    const isBurned = BURN_ADDRESSES.has(owner);

    return {
      rank: i + 1,       // raw rank before LP filtering — used for diagnostics
      address: owner,
      short: `${owner.slice(0, 4)}...${owner.slice(-4)}`,
      percentage: pct,
      program,
      isLP,
      isBurned,
      funder: null,
      fundedAt: null,
    };
  });

  // Re-rank real holders separately (non-LP) so rank #1 = top real wallet
  let realRank = 0;
  for (const h of holders) {
    if (!h.isLP) {
      realRank++;
      h.rank = realRank;
    }
  }

  // Log LP detection results for debugging
  const lps = holders.filter(h => h.isLP);
  const real = holders.filter(h => !h.isLP);
  console.log(`[Helius] LP accounts found: ${lps.length} | Real holders: ${real.length}`);
  if (lps.length === 0) {
    console.warn('[Helius] WARNING: No LP detected. Token may be very new, migrated, or LP burned.');
  }
  lps.forEach(lp => {
    console.log(`[Helius] LP: ${lp.short} | ${lp.percentage.toFixed(2)}% | program: ${lp.program}`);
  });

  return { mint, supply, holderCount: accounts.length, holders };
}

async function enrichWithFunders(holders) {
  const targets = holders.filter(h => !h.isLP).slice(0, 15);
  console.log('[Helius] Fetching funders for', targets.length, 'wallets...');

  // Batch in groups of 5 to avoid hammering the RPC
  const results = [];
  for (let i = 0; i < targets.length; i += 5) {
    const batch = targets.slice(i, i + 5);
    const batchResults = await Promise.allSettled(
      batch.map(h =>
        Promise.race([
          getFunder(h.address),
          new Promise(res => setTimeout(() => res(null), 8000))
        ])
      )
    );
    results.push(...batchResults);
    // Small delay between batches to avoid rate limits
    if (i + 5 < targets.length) await new Promise(r => setTimeout(r, 300));
  }

  for (let i = 0; i < targets.length; i++) {
    const funder = results[i].status === 'fulfilled' ? results[i].value : null;
    const holder = holders.find(h => h.address === targets[i].address);
    if (holder) holder.funder = funder;
  }

  return holders;
}

module.exports = { analyzeToken, enrichWithFunders, detectIsLP, DEX_PROGRAMS };
