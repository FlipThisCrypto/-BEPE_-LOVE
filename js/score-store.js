// Score persistence abstraction.
//
// v1: localStorage with wallet-namespaced keys. When a Chia wallet is
// connected (via js/wallet.js), scores write to `bepe.scores.<fingerprint>.v1`
// so they follow the wallet across devices/browsers. When no wallet is
// connected, scores write to `bepe.scores.anon.v1`.
//
// Phase 3b/3c: a real backend (Chia DataLayer or a small KV server) can swap
// in here without touching game code — the public API is stable.

const ANON_FINGERPRINT = "anon";
const PROFILE_KEY = "bepe.profile.v1";

let activeFingerprint = ANON_FINGERPRINT;

export function setActiveWallet(fingerprintOrNull) {
  activeFingerprint = fingerprintOrNull ? String(fingerprintOrNull) : ANON_FINGERPRINT;
}

export function getActiveWallet() {
  return activeFingerprint === ANON_FINGERPRINT ? null : activeFingerprint;
}

function keyFor(fp = activeFingerprint) {
  return `bepe.scores.${fp}.v1`;
}

function readAll() {
  try {
    const raw = localStorage.getItem(keyFor());
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeAll(data) {
  localStorage.setItem(keyFor(), JSON.stringify(data));
}

function migrateLegacyIfNeeded() {
  // Pre-Phase-3 builds wrote to `bepe.scores.v1`. If the active namespace is
  // anon and no record exists there yet, copy the legacy data over so users
  // don't lose their stats. Run once.
  if (activeFingerprint !== ANON_FINGERPRINT) return;
  if (localStorage.getItem(keyFor()) != null) return;
  const legacy = localStorage.getItem("bepe.scores.v1");
  if (legacy) localStorage.setItem(keyFor(), legacy);
}

function ensure() {
  migrateLegacyIfNeeded();
  let s = readAll();
  if (!s) {
    s = {
      brawl: {
        matches: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        currentStreak: 0,
        longestStreak: 0,
        bestRoundDelta: 0,   // largest single-round point lead
        history: [],         // last 20 match summaries
      },
      match: {
        roundsPlayed: 0,
        bestScore: 0,
        bestTimeMs: null,
        history: [],         // last 20 round summaries
      },
    };
    writeAll(s);
  }
  return s;
}

// ---------- Profile ----------
export function getProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    return raw ? JSON.parse(raw) : { name: null, walletAddr: null };
  } catch {
    return { name: null, walletAddr: null };
  }
}

export function setProfileName(name) {
  const p = getProfile();
  p.name = (name || "").trim().slice(0, 24) || null;
  localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
  return p;
}

// ---------- Brawl ----------
export function recordBrawlMatch(result) {
  const s = ensure();
  const b = s.brawl;
  b.matches += 1;
  if (result.outcome === "win") {
    b.wins += 1;
    b.currentStreak += 1;
    if (b.currentStreak > b.longestStreak) b.longestStreak = b.currentStreak;
  } else if (result.outcome === "loss") {
    b.losses += 1;
    b.currentStreak = 0;
  } else {
    b.draws += 1;
    b.currentStreak = 0;
  }
  if (typeof result.bestRoundDelta === "number" && result.bestRoundDelta > b.bestRoundDelta) {
    b.bestRoundDelta = result.bestRoundDelta;
  }
  b.history.unshift({
    ts: Date.now(),
    outcome: result.outcome,
    you: result.you,         // [{id, name, points, tier, element}, ...]
    opp: result.opp,
    rounds: result.rounds,   // [{youScore, oppScore, winner}, ...]
  });
  b.history = b.history.slice(0, 20);
  writeAll(s);
  return b;
}

export function getBrawlStats() {
  return ensure().brawl;
}

// ---------- Match game (Phase 4) ----------
export function recordMatchRound(result) {
  const s = ensure();
  const m = s.match;
  m.roundsPlayed += 1;
  if (typeof result.score === "number" && result.score > m.bestScore) m.bestScore = result.score;
  if (typeof result.timeMs === "number") {
    if (m.bestTimeMs == null || result.timeMs < m.bestTimeMs) m.bestTimeMs = result.timeMs;
  }
  m.history.unshift({
    ts: Date.now(),
    score: result.score,
    timeMs: result.timeMs,
    pairs: result.pairs,
    matchTrait: result.matchTrait,
  });
  m.history = m.history.slice(0, 20);
  writeAll(s);
  return m;
}

export function getMatchStats() {
  return ensure().match;
}

// ---------- Wipe (debug / reset) ----------
export function reset() {
  localStorage.removeItem(KEY);
}
