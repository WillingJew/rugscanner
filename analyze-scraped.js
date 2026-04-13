// analyze-scraped.js v4
// rowData: { rank -> { funder, percentage, clusterCount } } scraped from padre
// Helius: top holders + supply for accurate on-chain data
// New: dominant funder detection, coordinated wallet count signal

const { analyzeToken, enrichWithFunders } = require('./helius');
const { analyze } = require('./analyze');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic();

async function generateVerdict(analysisResult, holderCount, dominantFunder) {
  const { score, flags, noBuy, deathTrap, stats } = analysisResult;
  const flagSummary = flags.map(f =>
    `[${f.severity.toUpperCase()}] ${f.text}${f.detail ? ' — ' + f.detail : ''}`
  ).join('\n');

  const funderLine = dominantFunder
    ? `DOMINANT FUNDER: ${dominantFunder.funder} controls ${dominantFunder.count} wallets (cluster count from padre: ${dominantFunder.maxClusterCount})`
    : '';

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
${funderLine}

FLAGS:
${flagSummary || 'None'}

Rules:
- Death traps (score 90+, deathTrap=true): 2 sentences. Direct and brutal.
- Subtle bundles (score 50-89): 3 sentences. Explain the specific risk pattern.
- Clean coins (score 0-49, no noBuy): 1 sentence. Call it clean confidently.
- Never mention "score" or numbers. Speak like a trader.
- Do not start with "I" or "This coin".
- If there's a dominant funder, name it in your verdict.` }],
  });

  return response.content[0].text.trim();
}

async function analyzeScrapedRoute(req, res) {
  const { ca, lpAddress, rowData, mode } = req.body;
  const runAI = mode === 'ai';

  if (!ca) return res.status(400).json({ error: 'Missing token CA' });

  const rowCount = Object.keys(rowData || {}).length;
  console.log(`[AnalyzeScrape] CA: ${ca} | LP: ${lpAddress || 'none'} | Rows scraped: ${rowCount} | mode: ${mode}`);

  try {
    // ── Step 1: Helius top holders + supply ───────────────────────────────────
    const tokenData = await analyzeToken(ca);

    // ── Step 2: Mark LP ───────────────────────────────────────────────────────
    if (lpAddress) {
      for (const h of tokenData.holders) {
        if (h.address === lpAddress) { h.isLP = true; break; }
      }
    }

    // ── Step 3: Merge scraped row data into holders ───────────────────────────
    // rowData keys are ranks from padre — match to Helius holder ranks
    const realHolders = tokenData.holders.filter(h => !h.isLP);
    let mergedFunders = 0;
    let mergedPercentages = 0;

    for (const h of realHolders) {
      const scraped = rowData?.[String(h.rank)];
      if (!scraped) continue;

      if (scraped.funder && !h.funder) {
        h.funder = scraped.funder;
        h.funderSource = 'padre';
        mergedFunders++;
      }
      // Use scraped percentage if Helius percentage seems off
      if (scraped.percentage && scraped.percentage > 0) {
        h.percentagePadre = scraped.percentage; // store for reference
        mergedPercentages++;
      }
      if (scraped.clusterCount) {
        h.clusterCount = scraped.clusterCount;
      }
    }

    console.log(`[AnalyzeScrape] Merged ${mergedFunders} funders, ${mergedPercentages} percentages`);

    // ── Step 4: Find dominant funder from scraped data ────────────────────────
    const funderGroups = {};
    for (const h of realHolders) {
      if (!h.funder) continue;
      if (!funderGroups[h.funder]) funderGroups[h.funder] = { count: 0, maxClusterCount: 0, ranks: [] };
      funderGroups[h.funder].count++;
      funderGroups[h.funder].ranks.push(h.rank);
      if (h.clusterCount && h.clusterCount > funderGroups[h.funder].maxClusterCount) {
        funderGroups[h.funder].maxClusterCount = h.clusterCount;
      }
    }

    // Dominant funder = most appearances
    let dominantFunder = null;
    let maxCount = 0;
    for (const [funder, data] of Object.entries(funderGroups)) {
      if (data.count > maxCount) {
        maxCount = data.count;
        dominantFunder = { funder, ...data };
      }
    }

    if (dominantFunder) {
      console.log(`[AnalyzeScrape] Dominant funder: ${dominantFunder.funder} | ${dominantFunder.count} wallets | cluster: ${dominantFunder.maxClusterCount}`);
    }

    // ── Step 5: Helius funder enrichment for remaining wallets ────────────────
    const needsEnrichment = realHolders.filter(h => !h.funder);
    if (needsEnrichment.length > 0) {
      console.log(`[AnalyzeScrape] Helius enriching ${needsEnrichment.length} remaining wallets...`);
      await enrichWithFunders(tokenData.holders);
    }

    // ── Step 6: Score ─────────────────────────────────────────────────────────
    const analysisResult = analyze(tokenData);

    // ── Step 7: Boost score if coordinated cluster count is high ──────────────
    // padre's cluster count tells us how many wallets were funded in same time window
    // If dominant funder has cluster count of 10+, that's a strong coordination signal
    if (dominantFunder?.maxClusterCount >= 10) {
      const boost = Math.min(dominantFunder.maxClusterCount * 2, 30);
      analysisResult.score = Math.min(100, analysisResult.score + boost);
      analysisResult.bars = analysisResult.score >= 85 ? 5 : analysisResult.score >= 65 ? 4 : analysisResult.score >= 40 ? 3 : analysisResult.score >= 20 ? 2 : 1;
      analysisResult.flags.push({
        text: `${dominantFunder.maxClusterCount} wallets funded in coordinated time window by ${dominantFunder.funder}`,
        severity: dominantFunder.maxClusterCount >= 20 ? 'critical' : 'high',
        detail: `Padre detected ${dominantFunder.maxClusterCount} wallets funded together — coordinated bundle`
      });
      if (dominantFunder.maxClusterCount >= 15) {
        analysisResult.noBuy.push(`${dominantFunder.maxClusterCount} wallets coordinated by ${dominantFunder.funder}`);
      }
    }

    // ── Step 8: AI verdict ────────────────────────────────────────────────────
    let verdict = null;
    if (runAI) {
      try {
        verdict = await generateVerdict(analysisResult, tokenData.holderCount, dominantFunder);
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
      dominantFunder: dominantFunder || null,
      verdict,
      source: 'helius_with_padre_v4',
    });

  } catch (err) {
    console.error('[AnalyzeScrape] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { analyzeScrapedRoute };
