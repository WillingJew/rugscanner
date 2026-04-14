// analyze-scraped.js v5
// Input: ca, lpAddress, funderCounts { "XXXX…XXXX": count }, totalRows
// Simple: highest funder count / totalRows = ratio, flag accordingly

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
    ? `DOMINANT FUNDER: ${dominantFunder.name} appears on ${dominantFunder.count}/${dominantFunder.totalRows} sampled rows (${dominantFunder.pct}%)`
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
- Death traps (score 90+, deathTrap=true): 2 sentences. Direct and brutal. Name the funder if known.
- Subtle bundles (score 50-89): 3 sentences. Explain what gave it away.
- Clean coins (score 0-49, no noBuy): 1 sentence. Call it clean confidently.
- Never mention "score" or numbers. Speak like a trader.
- Do not start with "I" or "This coin".` }],
  });

  return response.content[0].text.trim();
}

async function analyzeScrapedRoute(req, res) {
  const { ca, lpAddress, funderCounts, totalRows, mode } = req.body;
  const runAI = mode === 'ai';

  if (!ca) return res.status(400).json({ error: 'Missing token CA' });

  console.log(`[AnalyzeScrape] CA: ${ca} | LP: ${lpAddress || 'none'} | Rows: ${totalRows} | Funders: ${Object.keys(funderCounts || {}).length} | mode: ${mode}`);

  try {
    // ── Step 1: Helius — real holder data ─────────────────────────────────────
    const tokenData = await analyzeToken(ca);

    // ── Step 2: Mark LP ───────────────────────────────────────────────────────
    if (lpAddress) {
      for (const h of tokenData.holders) {
        if (h.address === lpAddress) { h.isLP = true; break; }
      }
    }

    // ── Step 3: Funder enrichment ─────────────────────────────────────────────
    await enrichWithFunders(tokenData.holders);

    // ── Step 4: Score ─────────────────────────────────────────────────────────
    const analysisResult = analyze(tokenData);

    // ── Step 5: Apply funder count signal ─────────────────────────────────────
    // Find the dominant funder from scraped counts
    let dominantFunder = null;
    if (funderCounts && totalRows > 0) {
      let maxCount = 0;
      let maxName = null;
      for (const [name, count] of Object.entries(funderCounts)) {
        if (count > maxCount) { maxCount = count; maxName = name; }
      }

      if (maxName && maxCount >= 3) {
        const pct = Math.round((maxCount / totalRows) * 100);
        dominantFunder = { name: maxName, count: maxCount, totalRows, pct };

        console.log(`[AnalyzeScrape] Dominant funder: ${maxName} | ${maxCount}/${totalRows} rows (${pct}%)`);

        if (pct >= 70) {
          // Overwhelming — death trap
          analysisResult.score = Math.max(analysisResult.score, 90);
          analysisResult.bars = 5;
          analysisResult.deathTrap = true;
          analysisResult.noBuy.push(`${maxCount}/${totalRows} wallets funded by ${maxName} — coordinated bundle`);
          analysisResult.flags.unshift({
            text: `${maxCount}/${totalRows} sampled wallets share funder — coordinated bundle`,
            severity: 'critical',
            detail: `${pct}% of visible holders funded by ${maxName}`
          });
        } else if (pct >= 40) {
          // Strong signal
          analysisResult.score = Math.max(analysisResult.score, 70);
          analysisResult.bars = Math.max(analysisResult.bars, 4);
          analysisResult.noBuy.push(`${maxCount}/${totalRows} wallets share funder ${maxName}`);
          analysisResult.flags.unshift({
            text: `${maxCount}/${totalRows} sampled wallets share funder — likely bundle`,
            severity: 'critical',
            detail: `${pct}% of visible holders funded by ${maxName}`
          });
        } else if (pct >= 20 || maxCount >= 5) {
          // Notable
          analysisResult.score = Math.min(100, analysisResult.score + 20);
          analysisResult.bars = analysisResult.score >= 85 ? 5 : analysisResult.score >= 65 ? 4 : analysisResult.score >= 40 ? 3 : 2;
          analysisResult.flags.push({
            text: `${maxCount} wallets share funder ${maxName}`,
            severity: 'high',
            detail: `${pct}% of sampled holders funded by same address`
          });
        }
      }
    }

    // ── Step 6: AI verdict ────────────────────────────────────────────────────
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
      dominantFunder,
      verdict,
      source: 'helius_with_padre_v5',
    });

  } catch (err) {
    console.error('[AnalyzeScrape] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { analyzeScrapedRoute };
