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

async function getTokenSupply(mint) {
  const res = await fetch('https://api.mainnet-beta.solana.com', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'supply', method: 'getTokenSupply', params: [mint] })
  });
  const data = await res.json();
  console.log('[Helius] supply response:', JSON.stringify(data).slice(0, 200));
  if (data.error) return null;
  return data.result?.value?.uiAmount ?? null;
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
    return result?.value != null ? result.value / 1e9 : null; // lamports to SOL
  } catch { return null; }
}

async function getFunder(address) {
  try {
    // Get oldest transaction
    const sigs = await rpc('getSignaturesForAddress', [address, { limit: 1000 }]);
    if (!sigs?.length) return null;
    const oldest = sigs[sigs.length - 1].signature;

    // Parse it
    const tx = await rpc('getTransaction', [oldest, { 
      encoding: 'jsonParsed', 
      maxSupportedTransactionVersion: 0 
    }]);
    if (!tx) return null;

    const accounts = tx.transaction?.message?.accountKeys || [];
    const pre = tx.meta?.preBalances || [];
    const post = tx.meta?.postBalances || [];

    // Find who sent SOL — balance decreased, not system addr, not the wallet itself
    for (let i = 0; i < accounts.length; i++) {
      const pk = accounts[i]?.pubkey || accounts[i];
      if (!pk || pk === address) continue;
      if (SYSTEM_ADDRS.has(pk)) continue;
      const decrease = (pre[i] || 0) - (post[i] || 0);
      if (decrease >= 1000000) return pk; // at least 0.001 SOL sent
    }
    return null;
  } catch { return null; }
}

async function getWalletBirthTime(address) {
  try {
    const sigs = await rpc('getSignaturesForAddress', [address, { limit: 1000 }]);
    if (!sigs?.length) return null;
    const oldest = sigs[sigs.length - 1];
    return oldest.blockTime || null; // unix timestamp
  } catch { return null; }
}

async function analyzeToken(mint) {
  mint = mint.trim();
  console.log('[Helius] Analyzing', mint);

  const accounts = await getTopHolders(mint);

  if (!accounts?.length) throw new Error('No holders found for this token.');

  console.log('[Helius] Accounts:', accounts.length);

  const totalSupply = accounts.reduce((s, a) => s + (a.amount || 0), 0);

  const top25 = accounts
    .filter(a => a.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 25);

  const programs = await Promise.all(top25.map(a => getAccountProgram(a.owner)));

  const holders = top25.map((account, i) => {
    const owner = account.owner;
    const amount = account.amount;
    const pct = totalSupply > 0 ? Math.round((amount / totalSupply) * 10000) / 100 : 0;
    const program = programs[i];
    const isLP = i === 0 || DEX_PROGRAMS.has(program);
    return {
      rank: i + 1,
      address: owner,
      short: `${owner.slice(0,4)}...${owner.slice(-4)}`,
      percentage: pct,
      program,
      isLP,
      funder: null,
      fundedAt: null,
    };
  });

  return { mint, supply: totalSupply, holderCount: accounts.length, holders };
}
async function enrichWithFunders(holders) {
  // Only fetch for real (non-LP) top 15 holders
  const targets = holders.filter(h => !h.isLP).slice(0, 15);
  console.log('[Helius] Fetching funders + birth times for', targets.length, 'wallets...');

  // Fetch funders and birth times in parallel
  const [funderResults, birthResults] = await Promise.all([
    Promise.allSettled(
      targets.map(h => 
        Promise.race([
          getFunder(h.address),
          new Promise(res => setTimeout(() => res(null), 8000))
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
    holder.funder = funderResults[i].status === 'fulfilled' ? funderResults[i].value : null;
    holder.fundedAt = birthResults[i].status === 'fulfilled' ? birthResults[i].value : null;
  }

  return holders;
}

module.exports = { analyzeToken, enrichWithFunders, getTokenSupply, getWalletBirthTime };
