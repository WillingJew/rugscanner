// RugScanner Pro - Detection Engine
// Clean implementation of Jack's bundle detection criteria

function analyze(tokenData) {
  const { holders, holderCount } = tokenData;

  // Safety net: if no holder was marked as LP (scraper missed it), mark rank #1.
  // This prevents the LP from ever being counted as a real holder.
  const hasLP = holders.some(h => h.isLP);
  if (!hasLP) {
    console.warn('[Analyze] No LP marked — defaulting rank #1 to LP');
    const rank1 = holders.find(h => h.rank === 1);
    if (rank1) rank1.isLP = true;
  }

  const real = holders.filter(h => !h.isLP);

  const flags = [];
  const noBuy = [];
  let score = 0;

  function flag(text, severity, detail = '') {
    flags.push({ text, severity, detail });
  }

  // ── 1. DEATH TRAP — same funder across 90%+ of holders ──────────────────
  const funderMap = {};
  for (const h of real) {
    if (!h.funder) continue;
    funderMap[h.funder] = (funderMap[h.funder] || []);
    funderMap[h.funder].push(h);
  }

  const withFunder = real.filter(h => h.funder);
  let deathTrap = false;

  for (const [addr, group] of Object.entries(funderMap)) {
    if (withFunder.length < 3) continue;
    const ratio = group.length / withFunder.length;
    if (ratio >= 0.9 && group.length >= 5) {
      deathTrap = true;
      const ranks = group.map(h => h.rank);
      flag(
        `Death trap: ${group.length}/${real.length} holders funded by same wallet`,
        'critical',
        `Ranks ${Math.min(...ranks)}-${Math.max(...ranks)} — one entity owns this coin`
      );
      noBuy.push(`${group.length} holders share one funder — death trap`);
      score += 80;
      break;
    }
  }

  // ── 3. FUNDER CLUSTERS (non-death-trap) ──────────────────────────────────
  if (!deathTrap) {
    for (const [addr, group] of Object.entries(funderMap)) {
      if (group.length < 2) continue;
      const totalPct = group.reduce((s, h) => s + h.percentage, 0);
      const ranks = group.map(h => `#${h.rank}`).join(', ');

      if (group.length >= 5 || totalPct >= 12) {
        flag(`${group.length} wallets share funder — ${totalPct.toFixed(1)}% combined`, 'critical', `Ranks: ${ranks}`);
        noBuy.push(`Funder cluster controls ${totalPct.toFixed(1)}%`);
        score += 35;
      } else if (totalPct >= 4) {
        flag(`${group.length} wallets share funder — ${totalPct.toFixed(1)}% combined`, 'high', `Ranks: ${ranks}`);
        score += 18;
      } else {
        flag(`${group.length} wallets share funder`, 'medium', `Ranks: ${ranks}`);
        score += 8;
      }
    }
  }

   // ── 3b. CEX LABEL CLUSTERS ───────────────────────────────────────────────
  // Wallets funded by different addresses but same CEX label (e.g. 6x "Coinbase")
  const CEX_LABELS = ['coinbase', 'binance', 'kraken', 'okx', 'bybit', 'kucoin'];
  const cexLabelMap = {};

  for (const h of real) {
    if (!h.funderLabel) continue;
    const label = h.funderLabel.toLowerCase();
    const match = CEX_LABELS.find(cex => label.includes(cex));
    if (!match) continue;
    if (!cexLabelMap[match]) cexLabelMap[match] = [];
    cexLabelMap[match].push(h);
  }

  for (const [cex, group] of Object.entries(cexLabelMap)) {
    if (group.length < 3) continue;
    const totalPct = group.reduce((s, h) => s + h.percentage, 0);
    const ranks = group.map(h => `#${h.rank}`).join(', ');
    const label = cex.charAt(0).toUpperCase() + cex.slice(1);

    if (group.length >= 5 || totalPct >= 15) {
      flag(`${group.length} wallets all funded via ${label} — ${totalPct.toFixed(1)}% combined`, 'critical',
        `Ranks: ${ranks} — CEX-sourced cluster, coordinated setup disguised as retail`);
      noBuy.push(`${group.length} ${label}-funded wallets control ${totalPct.toFixed(1)}%`);
      score += 35;
    } else {
      flag(`${group.length} wallets all funded via ${label} — ${totalPct.toFixed(1)}% combined`, 'high',
        `Ranks: ${ranks} — same CEX funder across multiple wallets is suspicious`);
      score += 20;
    }
  }
  
  // ── 4. INDIVIDUAL WALLET % ────────────────────────────────────────────────
  for (const h of real) {
    if (h.percentage >= 8) {
      flag(`Rank #${h.rank} holds ${h.percentage.toFixed(1)}% — over 8%`, 'critical',
        'Single wallet with this much control will dump on buyers');
      noBuy.push(`Rank #${h.rank} holds ${h.percentage.toFixed(1)}%`);
      score += 40;
    } else if (h.percentage >= 4) {
      flag(`Rank #${h.rank} holds ${h.percentage.toFixed(1)}% — over 4%`, 'high',
        'Leverage risk — this wallet can move the chart');
      score += 18;
    }
  }

  // ── 5. IDENTICAL % GROUPS ─────────────────────────────────────────────────
  const pctGroups = {};
  for (const h of real) {
    const key = h.percentage.toFixed(1);
    pctGroups[key] = (pctGroups[key] || []);
    pctGroups[key].push(h);
  }
 for (const [pct, group] of Object.entries(pctGroups)) {
    if (group.length < 5) continue;

    if (group.length >= 8) {
      flag(`${group.length} wallets all hold exactly ${pct}% — identical holdings`, 'critical',
        'Natural buying never creates perfect identical percentages — this is a bundle');
      noBuy.push(`${group.length} wallets hold identical ${pct}% — coordinated bundle`);
      score += 50;
    } else if (group.length >= 5) {
      flag(`${group.length} wallets all hold exactly ${pct}% — identical holdings`, 'high',
        'Natural buying never creates perfect identical percentages');
      score += 20;
    }
  }

  // ── 6. SOL BALANCE UNIFORMITY ────────────────────────────────────────────
  // Identical SOL balances across top holders = funded from same source
  const withBal = real.filter(h => h.solBalance != null && h.solBalance > 0 && h.solBalance < 100);
  if (withBal.length >= 4) {
    // Group wallets within 0.005 SOL of each other (very tight — catches exact matches)
    const sorted = [...withBal].sort((a, b) => a.solBalance - b.solBalance);
    let bestGroup = [];
    for (let i = 0; i < sorted.length; i++) {
      const group = sorted.filter(h => Math.abs(h.solBalance - sorted[i].solBalance) <= 0.005);
      if (group.length > bestGroup.length) bestGroup = group;
    }

    if (bestGroup.length >= 4) {
      const avg = bestGroup.reduce((s, h) => s + h.solBalance, 0) / bestGroup.length;
      const totalPct = bestGroup.reduce((s, h) => s + h.percentage, 0);
      const ranks = bestGroup.map(h => `#${h.rank}`).join(', ');

      if (bestGroup.length >= 8) {
        flag(`${bestGroup.length} wallets all have identical SOL balance (${avg.toFixed(3)} SOL)`, 'critical',
          `Ranks: ${ranks} — ${totalPct.toFixed(1)}% combined`);
        noBuy.push(`${bestGroup.length} wallets share identical SOL balance`);
        score += 35;
      } else if (bestGroup.length >= 5) {
        flag(`${bestGroup.length} wallets share identical SOL balance (${avg.toFixed(3)} SOL)`, 'high',
          `Ranks: ${ranks} — ${totalPct.toFixed(1)}% combined`);
        score += 20;
      } else {
        flag(`${bestGroup.length} wallets share identical SOL balance (${avg.toFixed(3)} SOL)`, 'medium',
          `Ranks: ${ranks}`);
        score += 10;
      }
    }
  }

  // ── 7. TOP HOLDER CONCENTRATION ──────────────────────────────────────────

  // ── 6c. CLOCK BADGE DETECTION (scraped from Terminal UI) ─────────────────
  // Terminal shows clock icons with numbers indicating how many wallets share a funder
  // clockIconCount = how many rows had the icon, maxClockNumber = biggest group size
  const clockIconCount = tokenData.clockIconCount || 0;
  const maxClockNumber = tokenData.maxClockNumber || 0;

  if (clockIconCount > 0 || maxClockNumber > 0) {
    if (maxClockNumber >= 10) {
      flag(`${maxClockNumber} accounts connected via same funder (Terminal clock badge)`, 'critical',
        `${clockIconCount} rows flagged — Terminal detected coordinated funding across ${maxClockNumber} wallets`);
      noBuy.push(`${maxClockNumber} wallets connected — coordinated bundle`);
      score += 45;
    } else if (clockIconCount >= 10) {
      flag(`${clockIconCount} holders have clock badges — widespread funder connections`, 'critical',
        `Largest connected group: ${maxClockNumber} wallets`);
      noBuy.push(`${clockIconCount} holders flagged with funder connections`);
      score += 40;
    } else if (clockIconCount >= 4) {
      flag(`${clockIconCount} holders have clock badges — funder connections detected`, 'high',
        `Largest connected group: ${maxClockNumber} wallets`);
      score += 20;
    }
  }

  // ── 6d. SOFTWARE RUN DETECTION (scraped from Terminal UI) ────────────────
  // Consecutive holders using the same trading software = possible coordinated bundle
  // 4-6 in run top 10 = critical, below rank 10 = high, 7+ anywhere = critical
  const softwareRuns = tokenData.softwareRuns || [];
  for (const run of softwareRuns) {
    const { software, startRank, endRank, count } = run;
    const softwareLabel = software.charAt(0).toUpperCase() + software.slice(1);
    
    // Sum percentages of holders in this run
    let totalPct = 0;
    for (const r of run.ranks) {
      const h = real.find(x => x.rank === r);
      if (h) totalPct += h.percentage;
    }
    const pctLabel = totalPct > 0 ? ` — ${totalPct.toFixed(1)}% combined` : '';
    
    if (count >= 7) {
      // 7+ in a run anywhere is absurd
      flag(`${count} consecutive holders using ${softwareLabel} (ranks ${startRank}-${endRank})`, 'critical',
        `Same trading software across ${count} consecutive wallets${pctLabel} — strong bundle signal`);
      noBuy.push(`${count} consecutive ${softwareLabel} wallets at ranks ${startRank}-${endRank}`);
      score += 35;
    } else if (startRank <= 10) {
      // 4-6 in top 10 = critical
      flag(`${count} consecutive top-10 holders using ${softwareLabel} (ranks ${startRank}-${endRank})`, 'critical',
        `Same trading software across ${count} consecutive top wallets${pctLabel}`);
      noBuy.push(`${count} ${softwareLabel} wallets bundled in top 10 (ranks ${startRank}-${endRank})`);
      score += 30;
    } else {
      // 4-6 below rank 10 = high
      flag(`${count} consecutive holders using ${softwareLabel} (ranks ${startRank}-${endRank})`, 'high',
        `Same trading software across ${count} consecutive wallets${pctLabel}`);
      score += 15;
    }
  }

  // ── 6b. WALLET BIRTH TIME CLUSTERING ─────────────────────────────────────
  // If many holders' wallets were created within the same 5-minute window = coordinated
  const withBirth = real.filter(h => h.fundedAt != null);
  if (withBirth.length >= 4) {
    // Sort by birth time, then find the largest cluster within 300s (5 min)
    const sorted = [...withBirth].sort((a, b) => a.fundedAt - b.fundedAt);
    let bestCluster = [];

    for (let i = 0; i < sorted.length; i++) {
      const window = sorted.filter(h => h.fundedAt >= sorted[i].fundedAt && h.fundedAt <= sorted[i].fundedAt + 300);
      if (window.length > bestCluster.length) bestCluster = window;
    }

    if (bestCluster.length >= 5) {
      const totalPct = bestCluster.reduce((s, h) => s + h.percentage, 0);
      const ranks = bestCluster.map(h => `#${h.rank}`).join(', ');
      const spanSec = bestCluster[bestCluster.length - 1].fundedAt - bestCluster[0].fundedAt;
      const spanLabel = spanSec < 60 ? `${spanSec}s` : `${Math.round(spanSec / 60)}m`;

      if (bestCluster.length >= 8) {
        flag(`${bestCluster.length} wallets all created within ${spanLabel} of each other`, 'critical',
          `Ranks: ${ranks} — ${totalPct.toFixed(1)}% combined — coordinated wallet creation`);
        noBuy.push(`${bestCluster.length} wallets born in same ${spanLabel} window — coordinated`);
        score += 40;
      } else {
        flag(`${bestCluster.length} wallets created within ${spanLabel} of each other`, 'high',
          `Ranks: ${ranks} — ${totalPct.toFixed(1)}% combined`);
        score += 20;
      }
    }
  }

  const top5pct = real.slice(0, 5).reduce((s, h) => s + h.percentage, 0);
  const top10pct = real.slice(0, 10).reduce((s, h) => s + h.percentage, 0);

  if (top5pct >= 40) {
    flag(`Top 5 holders control ${top5pct.toFixed(1)}%`, 'high');
    score += 15;
  }
  if (top10pct >= 60) {
    flag(`Top 10 holders control ${top10pct.toFixed(1)}%`, 'high');
    score += 15;
  }

  // ── 7. STABILITY CREDIT FOR LARGE COINS ──────────────────────────────────
  if (noBuy.length === 0 && holderCount >= 2000) score = Math.max(0, score - 15);
  else if (noBuy.length === 0 && holderCount >= 1000) score = Math.max(0, score - 8);

  // ── SCORE FLOORS ──────────────────────────────────────────────────────────
  const crits = flags.filter(f => f.severity === 'critical').length;
  if (deathTrap) score = Math.max(score, 95);
  else if (crits >= 3) score = Math.max(score, 90);
  else if (crits >= 2) score = Math.max(score, 80);
  else if (crits >= 1) score = Math.max(score, 60);

  score = Math.min(100, Math.max(0, score));

  const bars = score >= 85 ? 5 : score >= 65 ? 4 : score >= 40 ? 3 : score >= 20 ? 2 : 1;

  // ── STATS FOR UI ──────────────────────────────────────────────────────────
  const funderClusters = Object.values(funderMap).filter(g => g.length >= 2).length;
  const topHolder = real[0];

  return {
    score,
    bars,
    flags,
    noBuy,
    holderCount,
    deathTrap,
    stats: {
      topHolderPct: topHolder?.percentage ?? null,
      funderClusters,
    }
  };
}

module.exports = { analyze };
