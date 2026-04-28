// Bepe Match — pure logic for the kid trait-matching game.
//
// Mechanic: cards face-down. Flip two. Two cards match if they share the
// round's announced trait value (e.g., both have jacket = "Love Club Jacket").
// Different NFTs, same trait. Teaches kids the trait vocabulary.
//
// Round announces: "Match by jacket" / "Match by eyes" / "Match by background".

import { pickRandom } from "./data.js";

// Difficulty presets. `pairs` = how many trait-matched pairs on the board.
// `traits` = which trait categories are eligible for the round.
export const DIFFICULTIES = {
  easy:   { pairs: 6,  cols: 4, label: "Easy",   traits: ["background", "jacket"] },
  medium: { pairs: 8,  cols: 4, label: "Medium", traits: ["eyes", "patch", "accessory"] },
  hard:   { pairs: 12, cols: 6, label: "Hard",   traits: ["mouth", "face", "patch"] },
};

const TRAIT_LABELS = {
  background: "Background",
  face:       "Face",
  eyes:       "Eyes",
  mouth:      "Mouth",
  jacket:     "Jacket",
  patch:      "Patch",
  accessory:  "Accessory",
};

export function traitLabel(t) {
  return TRAIT_LABELS[t] || t;
}

// Build a board: pick a trait, find `pairs` distinct values that have at
// least 2 NFTs each, pick 2 NFTs per value, shuffle. Returns { trait, value, cards }.
export function buildBoard(manifest, difficulty = "easy") {
  const cfg = DIFFICULTIES[difficulty] || DIFFICULTIES.easy;
  const trait = pickRandom(cfg.traits, 1)[0];

  // Group NFTs by their value for this trait.
  const groups = new Map();
  for (const nft of manifest) {
    const v = nft.traits[trait];
    if (!v) continue;
    if (!groups.has(v)) groups.set(v, []);
    groups.get(v).push(nft);
  }

  // Keep only groups with at least 2 NFTs.
  const eligible = [...groups.entries()].filter(([_, list]) => list.length >= 2);
  if (eligible.length < cfg.pairs) {
    // Should never happen with this collection, but fall back gracefully.
    throw new Error(`Not enough trait values with >=2 NFTs for ${trait}`);
  }

  // Pick `pairs` distinct values. Prefer values that aren't all the same NFTs
  // visually (random sampling does this for free).
  const chosenValues = pickRandom(eligible, cfg.pairs);

  // For each value, pick 2 NFTs.
  const cards = [];
  for (const [value, list] of chosenValues) {
    const two = pickRandom(list, 2);
    for (const nft of two) {
      cards.push({
        nft,
        trait,
        value,            // shared with its pair
        flipped: false,
        matched: false,
      });
    }
  }

  // Shuffle.
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }

  return {
    difficulty,
    trait,
    cols: cfg.cols,
    pairs: cfg.pairs,
    cards,
  };
}

// Two cards match if they share the round trait's value.
export function isMatch(cardA, cardB) {
  return cardA && cardB && cardA.trait === cardB.trait && cardA.value === cardB.value && cardA !== cardB;
}

// Scoring: every match awards points based on time since last match. Quick matches
// = big points; slow = floor of 50. Misses cost 10. Completion bonus scales with difficulty.
//
// score = sum(matchPoints) - misses * 10 + completionBonus
//
// matchPoints = max(50, 500 - elapsedSecSinceLastMatch * 25)
// completionBonus = pairs * 50 (only if board completed)

export function scoreMatch(elapsedSecSinceLast) {
  return Math.max(50, Math.round(500 - elapsedSecSinceLast * 25));
}

export function completionBonus(pairs) {
  return pairs * 50;
}

export function missPenalty() {
  return 10;
}
