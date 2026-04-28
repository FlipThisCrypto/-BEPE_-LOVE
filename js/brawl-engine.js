// Bepe Brawl — pure resolver logic. No DOM here, no I/O. Easy to unit-test or
// swap into a server later.
//
// A "match" = best of three rounds. Each round resolves one of your cards
// against the opponent's card in the same slot.
//
// Score per round = base points + element matchup bonus + ability adjustments.
// Highest score wins the round. Ties = both 0 for the round (push).

import { pickRandom } from "./data.js";

// ---------- element matchup (5-element wheel + opposed pair) ----------
//
// Cycle: Fire > Nature > Water > Fire (rock-paper-scissors loop)
// Opposed: Light <-> Arcane (mutually disrupt each other; high-roll wins)
// Same element = mirror, slight defensive bonus to the higher-tier card
// Cross (Fire/Light, etc.) = neutral

const CYCLE = ["Fire", "Nature", "Water"]; // each beats the next

function cycleEdge(a, b) {
  const ai = CYCLE.indexOf(a), bi = CYCLE.indexOf(b);
  if (ai < 0 || bi < 0) return 0;
  if (ai === bi) return 0;
  // a beats b if b is a's "next" in the cycle
  if (CYCLE[(ai + 1) % 3] === b) return +1;
  return -1;
}

export function elementBonus(yourEl, oppEl) {
  if (yourEl === oppEl) {
    // mirror — neutral, both get a tiny shield
    return { you: 5, opp: 5, kind: "mirror" };
  }
  // cycle: Fire/Nature/Water
  const edge = cycleEdge(yourEl, oppEl);
  if (edge === +1) return { you: 50, opp: 0, kind: "advantage" };
  if (edge === -1) return { you: 0,  opp: 50, kind: "disadvantage" };

  // Light <-> Arcane
  if ((yourEl === "Light" && oppEl === "Arcane") ||
      (yourEl === "Arcane" && oppEl === "Light")) {
    return { you: 30, opp: 30, kind: "clash" };
  }

  // anything else = neutral
  return { you: 0, opp: 0, kind: "neutral" };
}

// ---------- trait abilities ----------
// Single-trait powers, fired at the start of the round before scoring.
// These are intentionally lightweight in v1 — additive bonuses only, no state.

const ABILITIES = {
  // accessory
  "Foundation Halo":  { self: +20, label: "Halo +20" },
  "Krist Kiss":       { self: +15, label: "Kiss +15" },
  "Asters Wand":      { self: +25, label: "Wand +25" },
  "Anastasya Aura":   { self: +20, label: "Aura +20" },
  "Hyper Hex Lasers": { self: +30, label: "Lasers +30" },
  // patch
  "FOMO Flame Patch":   { opp: -15, label: "Flame -15 opp" },
  "Love Vault Patch":   { self: +10, label: "Vault +10" },
  "Lost Skull Patch":   { opp: -10, label: "Skull -10 opp" },
  "Chia Project Patch": { self: +5,  label: "Chia +5" },
  "Braided Heart Patch":{ self: +10, label: "Heart +10" },
};

export function abilitiesFor(card) {
  const out = [];
  const accessory = ABILITIES[card.traits.accessory];
  if (accessory) out.push({ trait: "accessory", value: card.traits.accessory, ...accessory });
  const patch = ABILITIES[card.traits.patch];
  if (patch) out.push({ trait: "patch", value: card.traits.patch, ...patch });
  return out;
}

// ---------- round resolution ----------

export function resolveRound(yourCard, oppCard) {
  const yAbil = abilitiesFor(yourCard);
  const oAbil = abilitiesFor(oppCard);
  const el = elementBonus(yourCard.element, oppCard.element);

  let yourScore = yourCard.points + el.you;
  let oppScore  = oppCard.points  + el.opp;

  // self bonuses
  for (const a of yAbil) if (a.self) yourScore += a.self;
  for (const a of oAbil) if (a.self) oppScore  += a.self;

  // opp drains
  for (const a of yAbil) if (a.opp)  oppScore  += a.opp;
  for (const a of oAbil) if (a.opp)  yourScore += a.opp;

  yourScore = Math.max(0, Math.round(yourScore));
  oppScore  = Math.max(0, Math.round(oppScore));

  let winner;
  if (yourScore > oppScore) winner = "you";
  else if (oppScore > yourScore) winner = "opp";
  else winner = "draw";

  return {
    yourCard, oppCard,
    yourScore, oppScore,
    elementBonus: el,
    yourAbilities: yAbil,
    oppAbilities:  oAbil,
    winner,
    delta: Math.abs(yourScore - oppScore),
  };
}

// ---------- match resolution ----------

export function runMatch(yourHand, oppHand) {
  if (yourHand.length !== 3 || oppHand.length !== 3) {
    throw new Error("Each hand must have exactly 3 cards");
  }
  const rounds = [];
  let yWins = 0, oWins = 0;
  let bestDelta = 0;
  for (let i = 0; i < 3; i++) {
    const r = resolveRound(yourHand[i], oppHand[i]);
    rounds.push(r);
    if (r.winner === "you") yWins += 1;
    else if (r.winner === "opp") oWins += 1;
    if (r.delta > bestDelta) bestDelta = r.delta;
  }
  let outcome;
  if (yWins > oWins) outcome = "win";
  else if (oWins > yWins) outcome = "loss";
  else outcome = "draw";

  return {
    rounds,
    yWins, oWins,
    outcome,
    bestRoundDelta: bestDelta,
  };
}

// ---------- AI hand drafting ----------
// Opponent draws a hand roughly tier-matched to the player so matches are
// fair without being predictable. Player average tier rank determines the band.

export function draftOpponentHand(manifest, yourHand) {
  const yourAvgRank = yourHand.reduce((a, c) => a + c.rank, 0) / 3;
  // Pull from a band ±25% of your average rank, with some randomness.
  const span = Math.max(150, Math.round(yourAvgRank * 0.5));
  const lo = Math.max(1, Math.round(yourAvgRank - span));
  const hi = Math.min(manifest.length, Math.round(yourAvgRank + span));
  const pool = manifest.filter(c => c.rank >= lo && c.rank <= hi);
  // Make sure no opponent card duplicates a player card.
  const yourIds = new Set(yourHand.map(c => c.id));
  const filtered = pool.filter(c => !yourIds.has(c.id));
  if (filtered.length < 3) {
    // Fallback: random from full manifest minus your hand.
    return pickRandom(manifest.filter(c => !yourIds.has(c.id)), 3);
  }
  return pickRandom(filtered, 3);
}

// Convenience: simulate a quick "random vs random" match (for testing).
export function simulateRandomMatch(manifest) {
  const yourHand = pickRandom(manifest, 3);
  const oppHand = draftOpponentHand(manifest, yourHand);
  return { yourHand, oppHand, ...runMatch(yourHand, oppHand) };
}
