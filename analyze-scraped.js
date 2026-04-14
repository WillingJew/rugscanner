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
    // We can only see ~25-30 rows out of potentially thousands due to virtualization.
    // The KEY metric is the RATIO: if 9/10 visible rows share a funder, that's 90%
    // coordination regardless of total holder count.
    // padre's per-row cluster count reflects time-based batches, NOT the full total —
    // so we count appearances ourselves and use the ratio as the signal.

    const funderGroups = {};
    let totalScrapedNonLP = 0;

    for (const h of realHolders) {
      if (!h.funder) continue;
      totalScrapedNonLP++;
      if (!funderGroups[h.funder]) funderGroups[h.funder] = { count: 0, maxClusterCount: 0, ranks: [] };
      funderGroups[h.funder].count++;
      funderGroups[h.funder].ranks.push(h.rank);
      if (h.clusterCount && h.clusterCount > funderGroups[h.funder].maxClusterCount) {
        funderGroups[h.funder].maxClusterCount = h.clusterCount;
      }
    }

    // Dominant funder = most appearances in scraped rows
    let dominantFunder = null;
    let maxCount = 0;
    for (const [funder, data] of Object.entries(funderGroups)) {
      if (data.count > maxCount) {
        maxCount = data.count;
        dominantFunder = { funder, ...data };
      }
    }

    if (dominantFunder && totalScrapedNonLP > 0) {
      dominantFunder.ratio = dominantFunder.count / totalScrapedNonLP;
      dominantFunder.totalScraped = totalScrapedNonLP;
      dominantFunder.realCount = dominantFunder.count; // appearances in scraped sample
      console.log(`[AnalyzeScrape] Dominant funder: ${dominantFunder.funder} | ${dominantFunder.count}/${totalScrapedNonLP} scraped rows (${(dominantFunder.ratio*100).toFixed(0)}%)`);
    }

    // ── Step 5: Helius funder enrichment for remaining wallets ────────────────
    const needsEnrichment = realHolders.filter(h => !h.funder);
    if (needsEnrichment.length > 0) {
      console.log(`[AnalyzeScrape] Helius enriching ${needsEnrichment.length} remaining wallets...`);
      await enrichWithFunders(tokenData.holders);
    }

    // ── Step 6: Score ─────────────────────────────────────────────────────────
    const analysisResult = analyze(tokenData);

    // ── Step 7: Score boost based on funder appearance ratio ────────────────────
    // Ratio of scraped rows sharing a funder is the most reliable signal we have.
    // 50%+ = almost certainly a coordinated bundle across the full holder list.
    if (dominantFunder && dominantFunder.ratio !== undefined) {
      const ratio = dominantFunder.ratio;
      const count = dominantFunder.count;
      const scraped = dominantFunder.totalScraped;

      if (ratio >= 0.5 && count >= 3) {
        // High ratio = strong coordination signal
        const severity = ratio >= 0.8 ? 'critical' : 'high';
        const pct = (ratio * 100).toFixed(0);

        analysisResult.flags.push({
          text: `${count}/${scraped} sampled wallets funded by ${dominantFunder.funder} (${pct}% of sample)`,
          severity,
          detail: `${pct}% of visible holders share one funder — coordinated bundle detected`
        });

        if (ratio >= 0.8) {
          analysisResult.noBuy.push(`${pct}% of wallets funded by same address — coordinated bundle`);
          analysisResult.score = Math.max(analysisResult.score, 85);
          analysisResult.bars = 5;
          analysisResult.deathTrap = true;
        } else if (ratio >= 0.5) {
          analysisResult.noBuy.push(`${pct}% of wallets share funder ${dominantFunder.funder}`);
          analysisResult.score = Math.max(analysisResult.score, 70);
          analysisResult.bars = Math.max(analysisResult.bars, 4);
        }

      } else if (count >= 5) {
        // Lower ratio but significant count
        analysisResult.flags.push({
          text: `${count} wallets share funder ${dominantFunder.funder}`,
          severity: count >= 10 ? 'high' : 'medium',
          detail: `Multiple wallets funded by same source — possible coordination`
        });
        const boost = Math.min(count * 2, 20);
        analysisResult.score = Math.min(100, analysisResult.score + boost);
        analysisResult.bars = analysisResult.score >= 85 ? 5 : analysisResult.score >= 65 ? 4 : analysisResult.score >= 40 ? 3 : analysisResult.score >= 20 ? 2 : 1;
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
