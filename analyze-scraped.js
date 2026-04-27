// analyze-scraped.js
// Receives: ca, lpAddress, mode
// Helius fetches real holder data, marks LP, scores, optional AI verdict

const { analyzeToken, enrichWithFunders } = require('./helius');
const { analyze } = require('./analyze');
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic();

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
  const { ca, lpAddress, lpRank, mode, clockIconCount, maxClockNumber, softwareRuns } = req.body;
  const runAI = mode === 'ai';

  if (!ca) return res.status(400).json({ error: 'Missing token CA' });

  console.log(`[AnalyzeScrape] CA: ${ca} | LP addr: ${lpAddress || 'none'} | LP rank: ${lpRank ?? 'none'} | mode: ${mode}`);

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
    });

  } catch (err) {
    console.error('[AnalyzeScrape] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { analyzeScrapedRoute };
