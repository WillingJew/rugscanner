// analyze-scraped.js v3
// Receives: CA + lpAddress + funderMap (scraped from padre)
// Uses Helius for: top holders + supply (accurate on-chain data)
// Merges padre funders into holder objects before scoring

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
FUNDER CLUSTERS: ${stats.funderClusters}

FLAGS:
${flagSummary || 'None'}

Rules:
- Death traps (score 90+, deathTrap=true): 2 sentences. Direct and brutal.
- Subtle bundles (score 50-89): 3 sentences. Explain the specific risk pattern.
- Clean coins (score 0-49, no noBuy): 1 sentence. Call it clean confidently.
- Never mention "score" or numbers. Speak like a trader.
- Do not start with "I" or "This coin".` }],
  });

  return response.content[0].text.trim();
}

async function analyzeScrapedRoute(req, res) {
  const { ca, lpAddress, funderMap, mode } = req.body;
  const runAI = mode === 'ai';

  if (!ca) return res.status(400).json({ error: 'Missing token CA' });

  console.log(`[AnalyzeScrape] CA: ${ca} | LP: ${lpAddress || 'none'} | Funders scraped: ${Object.keys(funderMap || {}).length} | mode: ${mode}`);

  try {
    // ── Step 1: Get real holder data from Helius ──────────────────────────────
    const tokenData = await analyzeToken(ca);

    // ── Step 2: Mark LP using padre-scraped address ───────────────────────────
    if (lpAddress) {
      for (const h of tokenData.holders) {
        if (h.address === lpAddress) {
          h.isLP = true;
          console.log(`[AnalyzeScrape] LP confirmed: ${lpAddress.slice(0,8)}... rank ${h.rank}`);
          break;
        }
      }
    }

    // ── Step 3: Merge padre-scraped funders into holder objects ───────────────
    // funderMap is { rank -> truncatedFunder } e.g. { "2": "2NJQY…yDoB", "3": "Coinbase" }
    // We match by rank to the Helius holder list
    if (funderMap && Object.keys(funderMap).length > 0) {
      const realHolders = tokenData.holders.filter(h => !h.isLP);
      for (const h of realHolders) {
        const scraped = funderMap[String(h.rank)];
        if (scraped && !h.funder) {
          h.funder = scraped; // use truncated funder from padre
          h.funderSource = 'padre';
        }
      }
      const mergedCount = realHolders.filter(h => h.funderSource === 'padre').length;
      console.log(`[AnalyzeScrape] Merged ${mergedCount} padre funders into holder data`);
    }

    // ── Step 4: Helius funder enrichment for wallets padre didn't cover ───────
    // Only enrich wallets that didn't get a funder from padre scrape
    const needsEnrichment = tokenData.holders.filter(h => !h.isLP && !h.funder);
    if (needsEnrichment.length > 0) {
      console.log(`[AnalyzeScrape] Helius enriching ${needsEnrichment.length} remaining wallets...`);
      await enrichWithFunders(tokenData.holders);
    }

    // ── Step 5: Score ─────────────────────────────────────────────────────────
    const analysisResult = analyze(tokenData);

    // ── Step 6: AI verdict ────────────────────────────────────────────────────
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
      source: 'helius_with_padre_funders',
    });

  } catch (err) {
    console.error('[AnalyzeScrape] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { analyzeScrapedRoute };
