// RugScanner Pro - Helius API
// Responsibility: holder addresses, token %, total count, wallet age, LP detection

function rpcUrl(apiKey) {
  if (process.env.HELIUS_RPC_URL) return process.env.HELIUS_RPC_URL;
  return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
}

const DEX_PROGRAMS = new Set([
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
]);

async function getTokenSupply(mintAddress, apiKey) {
  const res = await fetch(rpcUrl(apiKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'supply', method: 'getTokenSupply', params: [mintAddress]
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(`Helius: ${data.error.message}`);
  return data.result?.value?.uiAmount || null;
}

async function getTokenHolders(mintAddress, apiKey) {
  let all = [];
  let cursor = null;

  while (true) {
    const body = {
      jsonrpc: '2.0', id: 'holders', method: 'getTokenAccounts',
      params: { mint: mintAddress, limit: 1000, ...(cursor ? { cursor } : {}) }
    };
    const res = await fetch(rpcUrl(apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!data.result?.token_accounts?.length) break;
    all = [...all, ...data.result.token_accounts];
    cursor = data.result.cursor;
    if (!cursor || all.length >= 5000) break;
  }
  return all;
}

async function getAccountOwner(address, apiKey) {
  try {
    const res = await fetch(rpcUrl(apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'owner', method: 'getAccountInfo',
        params: [address, { encoding: 'base64' }]
      })
    });
    const data = await res.json();
    return data.result?.value?.owner || null;
  } catch { return null; }
}

async function getWalletAge(address, apiKey) {
  try {
    const res = await fetch(rpcUrl(apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'sigs', method: 'getSignaturesForAddress',
        params: [address, { limit: 1000 }]
      })
    });
    const data = await res.json();
    const sigs = data.result;
    if (!sigs?.length) return null;
    const oldest = sigs[sigs.length - 1];
    if (!oldest.blockTime) return null;
    return Math.floor(Date.now() / 1000) - oldest.blockTime;
  } catch { return null; }
}

async function analyzeToken(mintAddress, apiKey) {
  console.log('[Helius] Analyzing', mintAddress);

  const [totalSupply, accounts] = await Promise.all([
    getTokenSupply(mintAddress, apiKey),
    getTokenHolders(mintAddress, apiKey)
  ]);

  if (!totalSupply) throw new Error('Could not fetch token supply. Check the CA.');
  if (!accounts?.length) throw new Error('No holders found for this CA.');

  console.log('[Helius] Found', accounts.length, 'accounts');

  // Sort by amount, take top 25
  const sorted = accounts
    .filter(a => a.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 25);

  // Fetch account owners in parallel (for LP detection)
  const owners = await Promise.all(
    sorted.map(a => getAccountOwner(a.owner, apiKey))
  );

  const holders = sorted.map((account, idx) => {
    const owner = account.owner;
    const tokenAmount = account.amount / Math.pow(10, account.decimals || 6);
    const percentage = Math.round((tokenAmount / totalSupply) * 10000) / 100;
    const accountOwner = owners[idx];

    // LP detection
    const isDEX = accountOwner && DEX_PROGRAMS.has(accountOwner);
    const isLP = isDEX || (idx === 0 && !accountOwner);

    return {
      rank: idx + 1,
      address: owner,
      shortAddress: `${owner.slice(0, 4)}...${owner.slice(-4)}`,
      tokenAmount,
      percentage,
      accountOwner,
      isLP,
      // These get filled in by scraper
      funderAddress: null,
      clockNumber: null,
      hasLeaf: false,
      hasBundle: false,
      software: 'unknown',
      leafAge: null,
    };
  });

  return {
    mintAddress,
    totalSupply,
    holderCount: accounts.length,
    holders,
  };
}

module.exports = { analyzeToken };
