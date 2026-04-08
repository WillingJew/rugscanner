// Helius API wrapper — clean on-chain data for any Solana CA

const HELIUS_REST = 'https://api.helius.xyz';

// Use pre-built RPC URL from env (includes API key already embedded)
// Falls back to building from API key if RPC URL not set
function rpcUrl(apiKey) {
  if (process.env.HELIUS_RPC_URL) return process.env.HELIUS_RPC_URL;
  return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
}

async function getTokenHolders(mintAddress, apiKey) {
  let allAccounts = [];
  let cursor = null;

  // Paginate through all token accounts
  while (true) {
    const body = {
      jsonrpc: '2.0',
      id: 'get-holders',
      method: 'getTokenAccounts',
      params: {
        mint: mintAddress,
        limit: 1000,
        ...(cursor ? { cursor } : {})
      }
    };

    const res = await fetch(rpcUrl(apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await res.json();
    if (!data.result || !data.result.token_accounts) break;

    allAccounts = [...allAccounts, ...data.result.token_accounts];
    cursor = data.result.cursor;
    if (!cursor || data.result.token_accounts.length === 0) break;
    if (allAccounts.length >= 5000) break; // cap for performance
  }

  return allAccounts;
}

async function getWalletSOLBalance(address, apiKey) {
  const res = await fetch(rpcUrl(apiKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'get-balance',
      method: 'getBalance',
      params: [address]
    })
  });
  const data = await res.json();
  return data.result?.value ? data.result.value / 1e9 : null; // lamports to SOL
}

async function getWalletFundingSource(address, apiKey) {
  try {
    // Step 1: Get signatures, going back to find the very first one
    // Use 'before' pagination to get oldest transactions
    let oldestSig = null;
    let oldestTime = null;
    let cursor = undefined;

    // Get last page of signatures (oldest transactions)
    const sigsRes = await fetch(rpcUrl(apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'get-sigs',
        method: 'getSignaturesForAddress',
        params: [address, { limit: 1000 }]
      })
    });
    const sigsData = await sigsRes.json();
    const sigs = sigsData.result;
    if (!sigs || sigs.length === 0) return { funder: null, fundedAt: null };

    // Oldest = last in array
    const oldest = sigs[sigs.length - 1];
    oldestSig = oldest.signature;
    oldestTime = oldest.blockTime;

    // Step 2: Parse the oldest transaction
    const txRes = await fetch(rpcUrl(apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'get-tx',
        method: 'getTransaction',
        params: [oldestSig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
      })
    });
    const txData = await txRes.json();
    const tx = txData.result;
    if (!tx) return { funder: null, fundedAt: oldestTime };

    // Step 3: Find who sent SOL to this wallet
    // Look at pre/post balances — the account whose balance DECREASED is the funder
    const accounts = tx.transaction?.message?.accountKeys || [];
    const preBalances = tx.meta?.preBalances || [];
    const postBalances = tx.meta?.postBalances || [];

    let funderAddress = null;
    for (let i = 0; i < accounts.length; i++) {
      const pk = accounts[i]?.pubkey || accounts[i];
      if (pk === address) continue;
      // If this account's balance decreased, they sent SOL
      if (preBalances[i] > postBalances[i]) {
        funderAddress = pk;
        break;
      }
    }

    // Fallback: first account that isn't this wallet
    if (!funderAddress && accounts.length > 0) {
      const first = accounts[0]?.pubkey || accounts[0];
      if (first !== address) funderAddress = first;
    }

    return { funder: funderAddress, fundedAt: oldestTime };
  } catch (e) {
    console.error('[Helius] getWalletFundingSource error:', e.message);
    return { funder: null, fundedAt: null };
  }
}

async function getWalletIdentity(address, apiKey) {
  try {
    const res = await fetch(
      `${HELIUS_REST}/v1/wallet/${address}/identity?api-key=${apiKey}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.label || null;
  } catch {
    return null;
  }
}

async function getWalletAge(address, apiKey) {
  // Get first transaction timestamp to determine wallet age
  try {
    const res = await fetch(rpcUrl(apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'get-sigs',
        method: 'getSignaturesForAddress',
        params: [address, { limit: 1, before: null }]
      })
    });
    const data = await res.json();
    // Get last signature (oldest)
    const sigs = data.result;
    if (!sigs || sigs.length === 0) return null;

    // Get the oldest signature
    const oldestRes = await fetch(rpcUrl(apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'get-oldest',
        method: 'getSignaturesForAddress',
        params: [address, { limit: 1000 }]
      })
    });
    const oldestData = await oldestRes.json();
    const allSigs = oldestData.result;
    if (!allSigs || allSigs.length === 0) return null;

    const oldest = allSigs[allSigs.length - 1];
    if (!oldest.blockTime) return null;

    const ageSeconds = Math.floor(Date.now() / 1000) - oldest.blockTime;
    return ageSeconds;
  } catch {
    return null;
  }
}

async function getTokenSupply(mintAddress, apiKey) {
  const res = await fetch(rpcUrl(apiKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'get-supply',
      method: 'getTokenSupply',
      params: [mintAddress]
    })
  });
  const data = await res.json();
  console.log('[Helius] getTokenSupply response:', JSON.stringify(data).slice(0, 200));
  if (data.error) throw new Error(`Helius error: ${data.error.message || JSON.stringify(data.error)}`);
  return data.result?.value?.uiAmount || null;
}

// Known DEX program IDs that own liquidity pool token accounts
const DEX_PROGRAMS = new Set([
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',  // Raydium CPMM (alt)
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',  // Orca Whirlpool
  'So11111111111111111111111111111111111111112',    // Wrapped SOL (sometimes LP)
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', // Orca v2
  'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1', // Orca v1
  'MERLuDFBMmsHnsBPZw2sDQZHvXFMwp8EdjudcU2HKky',  // Mercurial
  'SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ',  // Saber
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',  // Token Program (burn address)
  'pump',                                            // Pump.fun (partial match)
]);

function isLPAddress(owner, programId) {
  // Check if owner or program is a known DEX
  if (DEX_PROGRAMS.has(owner)) return true;
  if (DEX_PROGRAMS.has(programId)) return true;
  // Pump.fun uses addresses containing 'pump'
  if (owner && owner.toLowerCase().includes('pump')) return true;
  return false;
}

// Get the program that owns an account (to detect DEX pool accounts)
async function getAccountOwner(address, apiKey) {
  try {
    const res = await fetch(rpcUrl(apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'get-account',
        method: 'getAccountInfo',
        params: [address, { encoding: 'base64' }]
      })
    });
    const data = await res.json();
    return data.result?.value?.owner || null;
  } catch {
    return null;
  }
}

// Main function: get full holder analysis for a CA
// deepScan=true fetches funding sources (slower but more accurate)
async function analyzeToken(mintAddress, apiKey, deepScan = false) {
  console.log(`[Helius] Analyzing ${mintAddress}`);

  // Get total supply first
  const totalSupply = await getTokenSupply(mintAddress, apiKey);
  if (!totalSupply) throw new Error('Could not fetch token supply. Check the CA.');

  // Get all token holders
  const accounts = await getTokenHolders(mintAddress, apiKey);
  if (!accounts || accounts.length === 0) throw new Error('No holders found for this CA.');

  console.log(`[Helius] Found ${accounts.length} total accounts`);

  // Sort by amount descending, take top 25
  const sorted = accounts
    .filter(a => a.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 25);

  // For each top holder, fetch SOL balance + funder in parallel
  const holderData = await Promise.all(sorted.map(async (account, idx) => {
    const owner = account.owner;
    const tokenAmount = account.amount / Math.pow(10, account.decimals || 6);
    const percentage = totalSupply > 0 ? (tokenAmount / totalSupply) * 100 : 0;

    // Fetch funder, identity, and account program owner in parallel
    const [funder, identity, accountOwner] = await Promise.all([
      getWalletFundingSource(owner, apiKey),
      getWalletIdentity(owner, apiKey),
      getAccountOwner(owner, apiKey),
    ]);

    return {
      rank: idx + 1,
      address: owner,
      shortAddress: `${owner.slice(0, 4)}...${owner.slice(-4)}`,
      tokenAmount,
      percentage: Math.round(percentage * 100) / 100,
      funderAddress: funder,
      identity,
      accountOwner, // program that owns this wallet
      isLP: false,
    };
  }));

  // DEBUG — log first 5 holders so we can see what we're working with
  console.log('[LP DEBUG] Top 5 holders:');
  holderData.slice(0, 5).forEach(h => {
    console.log(`  Rank ${h.rank}: ${h.address} | ${h.percentage}% | identity: ${h.identity} | accountOwner: ${h.accountOwner} | isLP: ${h.isLP}`);
  });

  // Detect LP using multiple signals
  for (const h of holderData) {
    // 1. Check if account is owned by a known DEX program
    if (h.accountOwner && isLPAddress(h.address, h.accountOwner)) {
      h.isLP = true;
      continue;
    }

    // 2. Check identity label from Helius
    const identityLower = (h.identity || '').toLowerCase();
    const knownDexes = ['raydium', 'orca', 'meteora', 'jupiter', 'whirlpool', 'pump.fun', 'pumpfun', 'serum', 'openbook'];
    if (knownDexes.some(dex => identityLower.includes(dex))) {
      h.isLP = true;
      continue;
    }

    // 3. Fallback: rank 1 with >20% = almost certainly LP on new meme coins
    if (h.rank === 1 && h.percentage >= 20) {
      h.isLP = true;
    }
  }

  return {
    mintAddress,
    totalSupply,
    holderCount: accounts.length,
    holders: holderData,
  };
}

module.exports = { analyzeToken };
