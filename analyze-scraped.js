// analyze-scraped.js v2
// Content script sends: CA + lpAddress (scraped from padre)
// Backend does: Helius top holders + supply, excludes known LP, scores, optionally verdicts

const { analyzeToken, enrichWithFunders, getTokenSupply } = require('./helius');
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
- Death traps (score 90+, deathTrap=true): exactly 2 sentences. Direct and brutal.
- Subtle bundles (score 50-89): exactly 3 sentences. Explain the specific risk pattern.
- Clean coins (score 0-49, no noBuy): exactly 1 sentence. Call it clean confidently.
- Never mention "score" or numbers. Speak like a trader.
- Do not start with "I" or "This coin".` }],
  });

  return response.content[0].text.trim();
}

async function analyzeScrapedRoute(req, res) {
  const { ca, lpAddress, mode } = req.body;
  const runAI = mode === 'ai';

  if (!ca) return res.status(400).json({ error: 'Missing token CA' });

  console.log(`[AnalyzeScrape] CA: ${ca} | LP: ${lpAddress || 'unknown'} | mode: ${mode}`);

  try {
    // ── Step 1: Fetch real holder data from Helius ────────────────────────────
    // analyzeToken fetches top holders + supply from chain
    const tokenData = await analyzeToken(ca);

    // ── Step 2: Mark LP using the address padre told us ───────────────────────
    // If padre gave us the LP address, use it to correctly flag that holder
    if (lpAddress) {
      for (const h of tokenData.holders) {
        if (h.address === lpAddress) {
          h.isLP = true;
          console.log(`[AnalyzeScrape] LP confirmed by padre scrape: ${lpAddress.slice(0,8)}... at rank ${h.rank}`);
          break;
        }
      }
    }

    // ── Step 3: Enrich with funders ───────────────────────────────────────────
    console.log(`[AnalyzeScrape] Enriching funders...`);
    await enrichWithFunders(tokenData.holders);

    // ── Step 4: Score ─────────────────────────────────────────────────────────
    const analysisResult = analyze(tokenData);

    // ── Step 5: AI verdict ────────────────────────────────────────────────────
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
      source: 'helius_with_padre_lp',
    });

  } catch (err) {
    console.error('[AnalyzeScrape] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { analyzeScrapedRoute };
