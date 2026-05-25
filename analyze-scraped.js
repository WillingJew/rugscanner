// analyze-scraped.js
// Receives: ca, lpAddress, mode
// Helius fetches real holder data, marks LP, scores, optional AI verdict

const { analyzeToken, enrichWithFunders } = require('./helius');
const { analyze } = require('./analyze');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const anthropic = new Anthropic();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Free-tier scan quota. Non-PRO users get this many scans before being paywalled.
// Lifetime, not monthly. PRO users skip the check entirely; their scan_count never
// increments, so if they later cancel they pick up where their free count left off.
const FREE_SCAN_LIMIT = 5;

async function generateVerdict(analysisResult, holderCount) {
  const { score, flags, noBuy, deathTrap, stats } = analysisResult;
  const flagSummary = flags.map(f =>
    `[${f.severity.toUpperCase()}] ${f.text}${f.detail ? ' — ' + f.detail : ''}`
  ).join('\n');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 200,
    messages: [{ role: 'user', content: `You are analyzing a Solana memecoin for rug pull risk. Give a trader verdict.

SCORE: ${score}/100
HOLDER COUNT: ${holderCount}
DEATH TRAP: ${deathTrap}
NO-BUY REASONS: ${noBuy.length > 0 ? noBuy.join('; ') : 'None'}
TOP HOLDER: ${stats.topHolderPct !== null ? stats.topHolderPct.toFixed(1) + '%' : 'Unknown'}

FLAGS:
${flagSummary || 'None'}

Rules:
- Death traps (score 90+, deathTrap=true): 2 sentences. Direct and brutal.
- Subtle bundles (score 50-89): 3 sentences. Explain what gave it away.
- Clean coins (score 0-49, no noBuy): 1 sentence. Call it clean confidently.
- Never mention "score" or numbers. Speak like a trader.
- Do not start with "I" or "This coin".` }],
  });

  return response.content[0].text.trim();
}

async function analyzeScrapedRoute(req, res) {
  const {
    ca, lpAddress, lpRank, mode,
    clockIconCount, maxClockNumber, softwareRuns,
    holders: scrapedHolders, // per-holder icon data from the Padre DOM scrape
  } = req.body;
  const runAI = mode === 'ai';

  if (!ca) return res.status(400).json({ error: 'Missing token CA' });

  // ── QUOTA CHECK ────────────────────────────────────────────────────────────
  // Look up subscription status and scan count. PRO users skip this gate;
  // free users get blocked at FREE_SCAN_LIMIT and are pushed to the upgrade flow.
  // The error message intentionally contains "PRO" so sidebar.js's existing
  // upgrade-prompt handler catches it without needing a frontend change.
  const { data: user } = await supabase
    .from('users')
    .select('stripe_subscription_status, scan_count')
    .eq('id', req.userId)
    .single();

  if (!user) return res.status(401).json({ error: 'User not found' });

  const isPro = user.stripe_subscription_status === 'active';
  const usedScans = user.scan_count ?? 0;

  if (!isPro && usedScans >= FREE_SCAN_LIMIT) {
    return res.status(402).json({
      code: 'quota_exceeded',
      error: `Free scan limit reached (${FREE_SCAN_LIMIT}/${FREE_SCAN_LIMIT}). Upgrade to PRO for unlimited scans.`,
    });
  }

  console.log(`[AnalyzeScrape] CA: ${ca} | LP addr: ${lpAddress || 'none'} | LP rank: ${lpRank ?? 'none'} | mode: ${mode} | scans: ${usedScans}/${isPro ? '∞' : FREE_SCAN_LIMIT}`);

  try {
    // Step 1: Helius — real holder data
    const tokenData = await analyzeToken(ca);

    // Step 2: Mark LP — Padre's scraped "LIQ POOL" label is the source of truth.
    // Helius can't reliably identify the pool because:
    //   (a) DEX_PROGRAMS only knows about a few AMMs (no pump.fun, Meteora, etc.)
    //   (b) Helius's top holders for a mint may not even include the pool's token account
    // So we trust Padre's literal "LIQ POOL" string match, mapped by RANK (not address —
    // Helius and Padre often disagree on which address represents the pool).
    if (lpRank != null || lpAddress) {
      // Clear any stale isLP flags Helius set
      for (const h of tokenData.holders) h.isLP = false;

      // Prefer rank match (Padre scrape), fall back to address match
      let marked = false;
      if (lpRank != null) {
        const target = tokenData.holders.find(h => h.rank === lpRank);
        if (target) { target.isLP = true; marked = true; }
      }
      if (!marked && lpAddress) {
        const target = tokenData.holders.find(h => h.address === lpAddress);
        if (target) { target.isLP = true; marked = true; }
      }
      if (!marked) {
        console.warn('[AnalyzeScrape] LP info supplied but no holder matched');
      }
    }

    // Step 3: Funder enrichment
    await enrichWithFunders(tokenData.holders);

    // Step 3b: Attach scraped clock badge data and software runs
    tokenData.clockIconCount = clockIconCount || 0;
    tokenData.maxClockNumber = maxClockNumber || 0;
    tokenData.softwareRuns = softwareRuns || [];

    // Step 3c: Merge scraped per-holder icon flags onto the Helius holders.
    // Helius gives us on-chain truth (balances, funders) but knows nothing about Padre's
    // UI icons (software brand, bundle/leaf/insider markers). The scraper extracts those
    // from the DOM. Match by address — that's the only key both sides agree on.
    // Without this merge, the consecutive-icon-runs detector in analyze.js has no input.
    if (Array.isArray(scrapedHolders)) {
      const byAddr = Object.create(null);
      for (const sh of scrapedHolders) {
        if (sh && sh.address) byAddr[sh.address] = sh;
      }
      for (const h of tokenData.holders) {
        const sh = byAddr[h.address];
        if (!sh) continue;
        h.software      = sh.software || null;
        h.isBundled     = !!sh.isBundled;
        h.isFreshWallet = !!sh.isFreshWallet;
        h.isInsider     = !!sh.isInsider;
      }
    }

    // Step 4: Score
    const analysisResult = analyze(tokenData);

    // Step 5: AI verdict
    let verdict = null;
    if (runAI) {
      try {
        verdict = await generateVerdict(analysisResult, tokenData.holderCount);
      } catch (aiErr) {
        console.error('[AnalyzeScrape] AI verdict failed:', aiErr.message);
      }
    }

    // Increment scan_count for non-PRO users only. PRO users have unlimited scans
    // and we don't want their count drifting — that way if they ever cancel, the
    // residual count reflects only free-tier usage. Fire-and-forget; a failure
    // here shouldn't block the response the user already paid (in time) to get.
    if (!isPro) {
      supabase
        .from('users')
        .update({ scan_count: usedScans + 1 })
        .eq('id', req.userId)
        .then(({ error }) => {
          if (error) console.error('[AnalyzeScrape] scan_count update failed:', error.message);
        });
    }

    return res.json({
      ca,
      lpAddress: lpAddress || null,
      score: analysisResult.score,
      bars: analysisResult.bars,
      flags: analysisResult.flags,
      noBuy: analysisResult.noBuy,
      deathTrap: analysisResult.deathTrap,
      stats: analysisResult.stats,
      holderCount: tokenData.holderCount,
      verdict,
      scansUsed: isPro ? null : usedScans + 1,
      scansLimit: isPro ? null : FREE_SCAN_LIMIT,
    });

  } catch (err) {
    console.error('[AnalyzeScrape] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { analyzeScrapedRoute };
