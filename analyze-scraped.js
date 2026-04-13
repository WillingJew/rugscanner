// analyze-scraped.js
// Receives pre-scraped holder data from content script.
// Uses Helius ONLY for: (1) token supply to fix percentages, (2) funder enrichment.

const { enrichWithFunders, getTokenSupply } = require('./helius');
const { analyze } = require('./analyze');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic();

async function generateVerdict(analysisResult, holderCount) {
  const { score, flags, noBuy, deathTrap, stats } = analysisResult;
  const flagSummary = flags.map(f => `[${f.severity.toUpperCase()}] ${f.text}${f.detail ? ' — ' + f.detail : ''}`).join('\n');

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
  const { ca, lpAddress, holders, holderCount, source, mode } = req.body;
  const runAI = mode === 'ai';

  if (!ca) return res.status(400).json({ error: 'Missing token CA' });
  if (!holders || !Array.isArray(holders) || holders.length === 0) {
    return res.status(400).json({ error: 'Missing or empty holders array' });
  }

  console.log(`[AnalyzeScrape] CA: ${ca} | Holders: ${holders.length} | LP: ${lpAddress || 'not found'} | mode: ${mode}`);

  try {
    // ── Step 1: Get real token supply from Helius to fix percentages ──────────
    let supply = null;
    try {
      supply = await getTokenSupply(ca);
      console.log(`[AnalyzeScrape] Supply: ${supply}`);
    } catch (err) {
      console.warn('[AnalyzeScrape] Could not fetch supply, using balance-sum fallback:', err.message);
    }

    // ── Step 2: Normalize holders with correct percentages ────────────────────
    const totalBalance = holders.reduce((s, h) => s + (h.balance || 0), 0);

    const normalizedHolders = holders.map((h, i) => {
      let percentage;
      if (supply && supply > 0 && h.balance != null) {
        // Correct: balance / total supply
        percentage = Math.round((h.balance / supply) * 10000) / 100;
      } else if (totalBalance > 0 && h.balance != null) {
        // Fallback: balance / sum of all scraped balances
        percentage = Math.round((h.balance / totalBalance) * 10000) / 100;
      } else {
        percentage = typeof h.percentage === 'number' ? h.percentage : 0;
      }

      return {
        rank: h.rank || i + 1,
        address: h.address || `unknown_${i + 1}`,
        short: h.address ? `${h.address.slice(0, 4)}...${h.address.slice(-4)}` : `unknown_${i + 1}`,
        percentage,
        balance: h.balance || null,
        isLP: false,
        isBurned: false,
        funder: null,
        fundedAt: null,
      };
    });

    // ── Step 3: Enrich with funders ───────────────────────────────────────────
    const enrichable = normalizedHolders.filter(h => !h.address.startsWith('unknown_'));
    if (enrichable.length > 0) {
      console.log(`[AnalyzeScrape] Enriching ${enrichable.length} wallets...`);
      await enrichWithFunders(normalizedHolders);
    }

    // ── Step 4: Score ─────────────────────────────────────────────────────────
    const tokenData = {
      holders: normalizedHolders,
      holderCount: holderCount || holders.length,
    };
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
      source: 'padre_scrape',
    });

  } catch (err) {
    console.error('[AnalyzeScrape] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { analyzeScrapedRoute };
