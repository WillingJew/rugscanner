// analyze-scraped.js
// Drop-in route handler for Express — receives pre-scraped holder data from
// the content script, skips Helius holder fetching entirely, only uses
// Helius for funder enrichment (what it's actually reliable for).

const { enrichWithFunders } = require('./helius');
const { analyze } = require('./analyze');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic();

// ── AI verdict generation ─────────────────────────────────────────────────────
async function generateVerdict(analysisResult, holderCount) {
  const { score, flags, noBuy, deathTrap, stats } = analysisResult;

  const flagSummary = flags.map(f => `[${f.severity.toUpperCase()}] ${f.text}${f.detail ? ' — ' + f.detail : ''}`).join('\n');

  const prompt = `You are analyzing a Solana memecoin for rug pull risk. Give a trader verdict.

SCORE: ${score}/100
HOLDER COUNT: ${holderCount}
DEATH TRAP: ${deathTrap}
NO-BUY REASONS: ${noBuy.length > 0 ? noBuy.join('; ') : 'None'}
TOP HOLDER: ${stats.topHolderPct !== null ? stats.topHolderPct.toFixed(1) + '%' : 'Unknown'}
FUNDER CLUSTERS: ${stats.funderClusters}

FLAGS:
${flagSummary || 'None'}

Rules for your response:
- Death traps (score 90+, deathTrap=true): exactly 2 sentences. Be direct and brutal. Tell them not to buy.
- Subtle bundles (score 50-89): exactly 3 sentences. Explain the specific risk pattern you see.
- Clean coins (score 0-49, no noBuy): exactly 1 sentence. You MUST call it clean if it is clean. Do not hedge on clean coins.
- Never mention "score" or numbers in your verdict. Speak like a trader, not a bot.
- Do not start with "I" or "This coin".`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text.trim();
}

// ── Route handler ─────────────────────────────────────────────────────────────
// Mount this in server.js as:
//   const { analyzeScrapedRoute } = require('./analyze-scraped');
//   app.post('/analyze-scraped', requireAuth, requirePro, analyzeScrapedRoute);

async function analyzeScrapedRoute(req, res) {
  const { ca, lpAddress, holders, holderCount, source, mode } = req.body;
  const runAI = mode === 'ai';

  // Basic validation
  if (!ca) return res.status(400).json({ error: 'Missing token CA' });
  if (!holders || !Array.isArray(holders) || holders.length === 0) {
    return res.status(400).json({ error: 'Missing or empty holders array' });
  }

  console.log(`[AnalyzeScrape] CA: ${ca} | Holders: ${holders.length} | LP: ${lpAddress || 'not found'} | Source: ${source}`);

  try {
    // Step 1: Normalize holder data from scrape
    // Ensure all holders have isLP=false (LP was already excluded by content script)
    const normalizedHolders = holders.map((h, i) => ({
      rank: h.rank || i + 1,
      address: h.address || `unknown_${i + 1}`,
      short: h.address ? `${h.address.slice(0, 4)}...${h.address.slice(-4)}` : `unknown_${i + 1}`,
      percentage: typeof h.percentage === 'number' ? h.percentage : 0,
      balance: h.balance || null,
      isLP: false,
      isBurned: false,
      funder: null,
      fundedAt: null,
    }));

    // Step 2: Enrich with funders via Helius (only thing we need Helius for now)
    // Skip wallets with unknown addresses
    const enrichable = normalizedHolders.filter(h => !h.address.startsWith('unknown_'));
    if (enrichable.length > 0) {
      console.log(`[AnalyzeScrape] Enriching ${enrichable.length} wallets with funder data...`);
      await enrichWithFunders(normalizedHolders);
    }

    // Step 3: Run scoring analysis
    const tokenData = {
      holders: normalizedHolders,
      holderCount: holderCount || holders.length,
    };
    const analysisResult = analyze(tokenData);

    // Step 4: Generate AI verdict (only for AI scan mode)
    let verdict = null;
    if (runAI) {
      try {
        verdict = await generateVerdict(analysisResult, tokenData.holderCount);
      } catch (aiErr) {
        console.error('[AnalyzeScrape] AI verdict failed:', aiErr.message);
      }
    }

    // Step 5: Return result
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
      source: 'padre_scrape',
    });

  } catch (err) {
    console.error('[AnalyzeScrape] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { analyzeScrapedRoute };
