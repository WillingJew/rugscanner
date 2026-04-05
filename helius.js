// Helius API wrapper — clean on-chain data for any Solana CA

const HELIUS_API = 'https://mainnet.helius-rpc.com';
const HELIUS_REST = 'https://api.helius.xyz';

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

    const res = await fetch(`${HELIUS_API}/?api-key=${apiKey}`, {
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
  const res = await fetch(`${HELIUS_API}/?api-key=${apiKey}`, {
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
    const res = await fetch(
      `${HELIUS_REST}/v1/wallet/${address}/funding?api-key=${apiKey}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.funder || null;
  } catch {
    return null;
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
    const res = await fetch(`${HELIUS_API}/?api-key=${apiKey}`, {
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
    const oldestRes = await fetch(`${HELIUS_API}/?api-key=${apiKey}`, {
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
  const res = await fetch(`${HELIUS_API}/?api-key=${apiKey}`, {
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

// Main function: get full holder analysis for a CA
async function analyzeToken(mintAddress, apiKey) {
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

    // Fetch SOL balance and funder in parallel
    const [solBalance, funder, identity] = await Promise.all([
      getWalletSOLBalance(owner, apiKey),
      getWalletFundingSource(owner, apiKey),
      getWalletIdentity(owner, apiKey),
    ]);

    return {
      rank: idx + 1,
      address: owner,
      shortAddress: `${owner.slice(0, 4)}...${owner.slice(-4)}`,
      tokenAmount,
      percentage: Math.round(percentage * 100) / 100,
      solBalance,
      funderAddress: funder,
      identity, // exchange label if known (e.g. "Binance", "Coinbase")
      isLP: false, // determined below
    };
  }));

  // Detect liquidity pool — typically the largest holder with identity "Raydium" or similar
  // or the one with ~0 SOL balance and very high token %
  const top = holderData[0];
  if (top && (
    top.percentage > 20 ||
    (top.identity && ['raydium', 'orca', 'meteora', 'jupiter'].some(dex =>
      top.identity.toLowerCase().includes(dex)
    ))
  )) {
    holderData[0].isLP = true;
  }

  return {
    mintAddress,
    totalSupply,
    holderCount: accounts.length,
    holders: holderData,
  };
}

module.exports = { analyzeToken };
