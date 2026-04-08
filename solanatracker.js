// Solana Tracker API wrapper
const ST_API = 'https://data.solanatracker.io';

async function getTokenInfo(mintAddress, apiKey) {
  const res = await fetch(`${ST_API}/tokens/${mintAddress}`, {
    headers: { 'x-api-key': apiKey }
  });
  if (!res.ok) throw new Error(`Solana Tracker error: ${res.status}`);
  return res.json();
}

async function getTopHolders(mintAddress, apiKey) {
  const res = await fetch(`${ST_API}/tokens/${mintAddress}/holders`, {
    headers: { 'x-api-key': apiKey }
  });
  if (!res.ok) throw new Error(`Holders fetch error: ${res.status}`);
  return res.json();
}

async function getTokenRisk(mintAddress, apiKey) {
  const res = await fetch(`${ST_API}/tokens/${mintAddress}/risk`, {
    headers: { 'x-api-key': apiKey }
  });
  if (!res.ok) return null;
  return res.json();
}

async function getWalletInfo(walletAddress, apiKey) {
  try {
    const res = await fetch(`${ST_API}/wallet/${walletAddress}`, {
      headers: { 'x-api-key': apiKey }
    });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

// Main analysis function using Solana Tracker
async function analyzeTokenST(mintAddress, apiKey, heliusApiKey, deepScan = false) {
  console.log(`[ST] Analyzing ${mintAddress}`);

  // Fetch token info and holders in parallel
  const [tokenInfo, holdersData, riskData] = await Promise.all([
    getTokenInfo(mintAddress, apiKey),
    getTopHolders(mintAddress, apiKey),
    getTokenRisk(mintAddress, apiKey),
  ]);

  const pool = tokenInfo?.pools?.[0];
  const totalSupply = pool?.tokenSupply ? pool.tokenSupply / Math.pow(10, tokenInfo.token?.decimals || 6) : null;
  const holderCount = holdersData?.total || tokenInfo?.holders || null;

  // Map holders to our standard format
  const rawHolders = holdersData?.holders || holdersData?.accounts || [];

  const holders = rawHolders.slice(0, 25).map((h, idx) => {
    const amount = h.amount || h.balance || 0;
    const pct = totalSupply && totalSupply > 0
      ? Math.round((amount / totalSupply) * 10000) / 100
      : (h.percentage || h.pct || 0);

    return {
      rank: idx + 1,
      address: h.wallet || h.owner || h.address,
      shortAddress: (h.wallet || h.owner || h.address || '').slice(0, 4) + '...' + (h.wallet || h.owner || h.address || '').slice(-4),
      tokenAmount: amount,
      percentage: pct,
      funderAddress: h.funder || h.fundedBy || null, // ST may provide this
      identity: h.label || h.identity || null,
      isLP: false,
      isSniper: h.isSniper || false,
      isInsider: h.isInsider || false,
      isBundler: h.isBundler || false,
    };
  });

  // If deep scan, fetch funder for each holder via Helius transaction history
  if (deepScan && heliusApiKey) {
    const { analyzeToken } = require('./helius');
    console.log('[ST] Deep scan: fetching funding sources via Helius...');
    const heliusData = await analyzeToken(mintAddress, heliusApiKey, true);

    // Merge funder data from Helius into our holder list
    for (const h of holders) {
      const heliusHolder = heliusData.holders?.find(hh => hh.address === h.address);
      if (heliusHolder?.funderAddress) {
        h.funderAddress = heliusHolder.funderAddress;
      }
    }
  }

  // LP detection
  for (const h of holders) {
    const identityLower = (h.identity || '').toLowerCase();
    const knownDexes = ['raydium', 'orca', 'meteora', 'jupiter', 'whirlpool', 'pump.fun', 'pumpfun'];
    if (knownDexes.some(dex => identityLower.includes(dex))) {
      h.isLP = true;
      continue;
    }
    // Rank 1 with no funder = LP
    if (h.rank === 1 && !h.funderAddress) {
      h.isLP = true;
    }
  }

  // Extract risk signals from Solana Tracker's built-in risk score
  const stRisk = riskData?.risks || [];
  const bundlerRisk = stRisk.find(r => r.name?.toLowerCase().includes('bundle'));
  const sniperRisk  = stRisk.find(r => r.name?.toLowerCase().includes('sniper'));
  const insiderRisk = stRisk.find(r => r.name?.toLowerCase().includes('insider'));

  return {
    mintAddress,
    totalSupply,
    holderCount,
    holders,
    stRiskScore: riskData?.score || null,
    stRiskLevel: riskData?.level || null,
    stRisks: stRisk,
    bundlerRisk,
    sniperRisk,
    insiderRisk,
    lpBurn: pool?.lpBurn || null,
    marketCap: pool?.marketCap?.usd || null,
  };
}

module.exports = { analyzeTokenST };
