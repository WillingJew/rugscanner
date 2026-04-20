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

// Known DEX program IDs — these own LP token accounts
const DEX_PROGRAMS = new Set([
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',  // Orca Whirlpool
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
]);

// System addresses that are never real funders
const SYSTEM_ADDRS = new Set([
  '11111111111111111111111111111111',
  'ComputeBudget111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv',
  'SysvarRent111111111111111111111111111111111',
  'SysvarC1ock11111111111111111111111111111111',
]);

// ── PLATFORM DETECTION ──────────────────────────────────────────────────────
// These are known fee recipient / referral wallet addresses used by each platform.
// When a wallet's buy transaction includes one of these as an account (receiving SOL),
// we know which platform was used.
//
// TO ADD MORE: Look up a known Axiom/Bullx/Photon buy on Solscan, find the fee
// recipient account in the transaction (a small SOL transfer ~0.9-1% of trade),
// and add it here. These addresses are stable — platforms rarely rotate fee wallets.
//
// Current confirmed addresses (verified via Solscan transaction analysis):
const PLATFORM_ADDRESSES = {
  // Axiom (axiom.trade) — fee recipient
  'HWEoBxYs7ssKuudEjzjmpileC9GgN9qDqSb4cCmvFBbq': 'Axiom',
  // Photon (photon-sol.tinyastro.io) — fee recipient  
  'DNfuF1L62WWyW3pNakVkyGGFzVVhj4Yr52jSmdTXhSH9': 'Photon',
  'AVUCZyuT35YSuj4RxZCMoRKnHXSxCBDZBJvHpSGJCGLa': 'Photon',
  // BullX (bullx.io) — fee recipient
  'BULLXKe4UmBGHkiSpnTxjHADpJCGmFpYBGpWHiLMUNv9': 'BullX',
  'G3q4VYdkW2DiCXPvdLFxmPVBuQhiU3i3e3LbGNhvNDLK': 'BullX',
  // GMGN (gmgn.ai)
  'GMGNfeerecipient1111111111111111111111111111': 'GMGN',
  // Trojan (trojan.trade) — Telegram bot
  'TrojanfeeRecipient111111111111111111111111111': 'Trojan',
  // Banana Gun (banana.gun)
  'BananaGunFeeRecipient1111111111111111111111111': 'Banana',
  // Maestro (maestrobots.com) — Telegram bot
  'MaestroFeeRecipient111111111111111111111111111': 'Maestro',
  // pump.fun
  '6EF8rrecvSoURWuQHoE6dVsXMCBGBHeLQmWuHYHHnFbK': 'pump.fun',
  'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1': 'pump.fun',
};

// Jito tip accounts — these appear in bot transactions as MEV tips
// If a wallet's FIRST transaction included a Jito tip, it was a bot buy (not organic)
const JITO_TIP_ACCOUNTS = new Set([
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt13lfAdj9',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
  'r21Gamwd9h1eYFsfkg4sTVtCjLSBHmq7cnZbgdkSyPB',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
]);

// ── PLATFORM DETECTION from transaction ─────────────────────────────────────
// Scans a parsed transaction's account keys for known platform fee addresses.
// Also checks for Jito tip accounts (= bot buy signal).
function detectPlatformFromTx(tx) {
  if (!tx) return null;

  const accounts = tx.transaction?.message?.accountKeys || [];
  const pre  = tx.meta?.preBalances  || [];
  const post = tx.meta?.postBalances || [];

  // Check each account in the transaction
  for (let i = 0; i < accounts.length; i++) {
    const pk = accounts[i]?.pubkey || accounts[i];
    if (!pk) continue;

    // Direct platform fee wallet match
    if (PLATFORM_ADDRESSES[pk]) return PLATFORM_ADDRESSES[pk];

    // Jito tip = bot buy (platform unknown but flaggable)
    if (JITO_TIP_ACCOUNTS.has(pk)) {
      const received = (post[i] || 0) - (pre[i] || 0);
      if (received > 0) return 'Bot (Jito)';
    }
  }

  // Also check inner instructions for program calls
  const innerInstructions = tx.meta?.innerInstructions || [];
  for (const inner of innerInstructions) {
    for (const ix of (inner.instructions || [])) {
      const prog = ix.programId || ix.program;
      if (prog && PLATFORM_ADDRESSES[prog]) return PLATFORM_ADDRESSES[prog];
    }
  }

  return null;
}

async function getTokenSupply(mint) {
  const result = await rpc('getTokenSupply', [mint]);
  return result?.value?.uiAmount || null;
}

async function getTopHolders(mint) {
  let all = [];
  let cursor = null;
  while (all.length < 5000) {
    const body = { jsonrpc: '2.0', id: 'holders', method: 'getTokenAccounts',
      params: { mint, limit: 1000, ...(cursor ? { cursor } : {}) } };
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

// Returns { funder, platform } — platform is the trading terminal used for the
// FIRST transaction this wallet ever made (most likely the buy that onboarded it).
async function getFunderAndPlatform(address) {
  try {
    const sigs = await rpc('getSignaturesForAddress', [address, { limit: 1000 }]);
    if (!sigs?.length) return { funder: null, platform: null };
    const oldest = sigs[sigs.length - 1].signature;

    const tx = await rpc('getTransaction', [oldest, { 
      encoding: 'jsonParsed', 
      maxSupportedTransactionVersion: 0 
    }]);
    if (!tx) return { funder: null, platform: null };

    const accounts = tx.transaction?.message?.accountKeys || [];
    const pre  = tx.meta?.preBalances  || [];
    const post = tx.meta?.postBalances || [];

    // Detect platform from this transaction
    const platform = detectPlatformFromTx(tx);

    // Find funder (who sent SOL)
    let funder = null;
    for (let i = 0; i < accounts.length; i++) {
      const pk = accounts[i]?.pubkey || accounts[i];
      if (!pk || pk === address) continue;
      if (SYSTEM_ADDRS.has(pk)) continue;
      const decrease = (pre[i] || 0) - (post[i] || 0);
      if (decrease >= 1000000) { funder = pk; break; }
    }

    return { funder, platform };
  } catch { return { funder: null, platform: null }; }
}

// Keep old getFunder for backward compat
async function getFunder(address) {
  const { funder } = await getFunderAndPlatform(address);
  return funder;
}

async function getWalletBirthTime(address) {
  try {
    const sigs = await rpc('getSignaturesForAddress', [address, { limit: 1000 }]);
    if (!sigs?.length) return null;
    const oldest = sigs[sigs.length - 1];
    return oldest.blockTime || null;
  } catch { return null; }
}

async function analyzeToken(mint) {
  console.log('[Helius] Analyzing', mint);

  const [supply, accounts] = await Promise.all([
    getTokenSupply(mint),
    getTopHolders(mint)
  ]);

  if (!supply) throw new Error('Could not fetch token supply. Is this a valid Solana token CA?');
  if (!accounts?.length) throw new Error('No holders found.');

  console.log('[Helius] Supply:', supply, '| Accounts:', accounts.length);

  const top25 = accounts
    .filter(a => a.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 25);

  const programs = await Promise.all(top25.map(a => getAccountProgram(a.owner)));

  const holders = top25.map((account, i) => {
    const owner   = account.owner;
    const amount  = account.amount / Math.pow(10, account.decimals || 6);
    const pct     = Math.round((amount / supply) * 10000) / 100;
    const program = programs[i];
    const isLP    = i === 0 || DEX_PROGRAMS.has(program);

    return {
      rank: i + 1,
      address: owner,
      short: `${owner.slice(0,4)}...${owner.slice(-4)}`,
      percentage: pct,
      program,
      isLP,
      funder: null,
      fundedAt: null,
      platform: null,   // ← NEW: trading platform detected from tx history
    };
  });

  return { mint, supply, holderCount: accounts.length, holders };
}

async function enrichWithFunders(holders) {
  const targets = holders.filter(h => !h.isLP).slice(0, 15);
  console.log('[Helius] Fetching funders + birth times + platforms for', targets.length, 'wallets...');

  // Fetch funder+platform combos and birth times in parallel
  const [funderResults, birthResults] = await Promise.all([
    Promise.allSettled(
      targets.map(h =>
        Promise.race([
          getFunderAndPlatform(h.address),
          new Promise(res => setTimeout(() => res({ funder: null, platform: null }), 8000))
        ])
      )
    ),
    Promise.allSettled(
      targets.map(h =>
        Promise.race([
          getWalletBirthTime(h.address),
          new Promise(res => setTimeout(() => res(null), 8000))
        ])
      )
    )
  ]);

  for (let i = 0; i < targets.length; i++) {
    const holder = holders.find(h => h.address === targets[i].address);
    if (!holder) continue;

    if (funderResults[i].status === 'fulfilled') {
      holder.funder   = funderResults[i].value?.funder   ?? null;
      holder.platform = funderResults[i].value?.platform ?? null;
    }
    holder.fundedAt = birthResults[i].status === 'fulfilled' ? birthResults[i].value : null;
  }

  // Log platform breakdown for debugging
  const platformCounts = {};
  for (const h of targets) {
    const p = holders.find(x => x.address === h.address)?.platform;
    if (p) platformCounts[p] = (platformCounts[p] || 0) + 1;
  }
  if (Object.keys(platformCounts).length > 0) {
    console.log('[Helius] Platforms detected:', platformCounts);
  }

  return holders;
}

// Export PLATFORM_ADDRESSES so analyze.js can reference platform names cleanly
module.exports = {
  analyzeToken,
  enrichWithFunders,
  getTokenSupply,
  getWalletBirthTime,
  PLATFORM_ADDRESSES,
};
