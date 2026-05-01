// Bepe Match — UI controller. State machine: home -> game -> result.
//
// Talks to match-engine for board generation/scoring and score-store for
// persistence. Same score-store abstraction the brawl uses, so wallet-linked
// storage in Phase 3 picks both up at once.

import { loadManifest, tierClass } from "./data.js";
import {
  DIFFICULTIES, buildBoard, isMatch, scoreMatch, completionBonus, missPenalty, traitLabel,
} from "./match-engine.js";
import { recordMatchRound, getMatchStats, getProfile, setProfileName, submitToLeaderboard } from "./score-store.js";
import { renderLeaderboard } from "./leaderboard.js";

let manifest = [];
let view = "home";
let board = null;
let difficulty = "easy";

// Game runtime state
let firstFlipped = null;
let lockBoard = false;
let pairsFound = 0;
let misses = 0;
let score = 0;
let startTime = 0;
let lastMatchTime = 0;
let timerHandle = null;

const $ = (sel) => document.querySelector(sel);

function setView(v) { view = v; render(); }

// ---------- HOME ----------
function renderHome() {
  const stats = getMatchStats();
  const profile = getProfile();
  const fmtTime = ms => {
    if (!ms) return "—";
    const s = ms / 1000;
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  };
  return `
    <section class="play-hero">
      <div class="eyebrow">Match Game · Kid-Friendly</div>
      <h1><span class="gradient">Bepe Match</span></h1>
      <p class="lead">
        Flip two cards. Match them by the trait shown at the top. Find every pair
        as fast as you can — the quicker you are, the higher your score.
      </p>

      <div class="difficulty-row">
        ${Object.entries(DIFFICULTIES).map(([key, cfg]) => `
          <button class="diff-card${difficulty === key ? " active" : ""}" data-diff="${key}">
            <div class="diff-label">${cfg.label}</div>
            <div class="diff-detail">${cfg.pairs} pairs</div>
            <div class="diff-detail-sub">${cfg.cols * (cfg.pairs * 2 / cfg.cols)} cards</div>
          </button>
        `).join("")}
      </div>

      <div class="actions" style="justify-content:center; margin-top: 8px;">
        <button class="btn primary big" id="startGame">▶ Start Game</button>
      </div>

      <div class="profile-row">
        <label class="profile-label" for="profileName">Player name</label>
        <input type="text" id="profileName" maxlength="24"
          placeholder="Anonymous Bepe" value="${profile.name ?? ""}" />
      </div>
    </section>

    <section class="section">
      <h2>Your Match Stats</h2>
      <div class="grid-3">
        <div class="feature"><b>${stats.roundsPlayed}</b><p>Rounds Played</p></div>
        <div class="feature"><b>${stats.bestScore}</b><p>Best Score</p></div>
        <div class="feature"><b>${fmtTime(stats.bestTimeMs)}</b><p>Fastest Time</p></div>
      </div>
      ${stats.history.length ? `
        <h3 style="margin-top:24px;">Recent Rounds</h3>
        <ul class="history">
          ${stats.history.slice(0, 6).map(h => {
            const date = new Date(h.ts).toLocaleString();
            return `<li>
              <span class="mark">🎯</span>
              <span class="when">${date} · Match by ${traitLabel(h.matchTrait)}</span>
              <span class="rounds">${h.score} pts · ${fmtTime(h.timeMs)}</span>
            </li>`;
          }).join("")}
        </ul>
      ` : `<p style="color:var(--ink-2); margin-top:18px;">No rounds yet — pick a difficulty above and start.</p>`}
    </section>

    <section class="section leaderboard">
      <h2>🏆 Global Leaderboard</h2>
      <p style="color: var(--ink-2); margin: 0 0 6px;">Best score per wallet. Connect your wallet to track your rank.</p>
      <div id="matchLeaderboardMount"></div>
    </section>

    <section class="section">
      <h2>How to play</h2>
      <div class="grid-3">
        <div class="feature"><b>1. Flip two</b><p>Tap any face-down card. It flips and shows you the Bepe plus their trait.</p></div>
        <div class="feature"><b>2. Match the trait</b><p>If the second card has the same trait value (e.g., both wear "Love Club Jacket"), it's a match!</p></div>
        <div class="feature"><b>3. Beat the clock</b><p>Quick matches earn more points. Find every pair to win the round and collect the completion bonus.</p></div>
      </div>
    </section>
  `;
}

function wireHome() {
  document.querySelectorAll(".diff-card").forEach(btn => {
    btn.addEventListener("click", () => {
      difficulty = btn.dataset.diff;
      render();
    });
  });
  $("#startGame")?.addEventListener("click", startGame);
  $("#profileName")?.addEventListener("change", (e) => setProfileName(e.target.value));
  renderLeaderboard("match", "#matchLeaderboardMount").catch(() => {});
}

// ---------- GAME ----------
function startGame() {
  board = buildBoard(manifest, difficulty);
  firstFlipped = null;
  lockBoard = false;
  pairsFound = 0;
  misses = 0;
  score = 0;
  startTime = performance.now();
  lastMatchTime = startTime;
  setView("game");
  startTimer();
}

function startTimer() {
  stopTimer();
  timerHandle = setInterval(() => {
    const t = $("#matchTimer");
    if (t) t.textContent = formatElapsed(performance.now() - startTime);
  }, 250);
}

function stopTimer() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = null;
}

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function renderGame() {
  if (!board) return renderHome();
  return `
    <section class="play-hero" style="margin-bottom: 14px; padding-top: 16px;">
      <div class="eyebrow">Match by ${traitLabel(board.trait)}</div>
      <h1 style="font-size:clamp(36px,6vw,64px); margin: 6px 0 6px;">
        Find <span class="gradient">${board.pairs}</span> pairs
      </h1>
      <p class="lead" style="font-size:16px; max-width:600px; margin:0 auto 14px;">
        Flip two cards. Match them if they share the same <b>${traitLabel(board.trait)}</b>.
      </p>
      <div class="hud">
        <div class="hud-cell"><span class="hud-label">Pairs</span><span class="hud-value" id="hudPairs">${pairsFound} / ${board.pairs}</span></div>
        <div class="hud-cell"><span class="hud-label">Score</span><span class="hud-value" id="hudScore">${score}</span></div>
        <div class="hud-cell"><span class="hud-label">Time</span><span class="hud-value" id="matchTimer">0:00</span></div>
        <div class="hud-cell"><span class="hud-label">Misses</span><span class="hud-value" id="hudMisses">${misses}</span></div>
      </div>
      <div class="actions" style="justify-content:center; margin-top: 10px;">
        <button class="btn ghost" id="abortGame">← Quit</button>
      </div>
    </section>

    <section class="section match-board-shell">
      <div class="match-board" style="grid-template-columns: repeat(${board.cols}, minmax(0, 1fr));">
        ${board.cards.map((c, i) => `
          <div class="match-card${c.flipped ? " flipped" : ""}${c.matched ? " matched" : ""}" data-idx="${i}">
            <div class="mc-inner">
              <div class="mc-back">
                <div class="rune">♥</div>
              </div>
              <div class="mc-front">
                <img src="${c.nft.thumb}" alt="${c.nft.name}" loading="lazy" />
                <div class="mc-front-meta">
                  <span class="tier ${tierClass(c.nft.tier)}">${c.nft.tier}</span>
                </div>
                <div class="mc-trait">
                  <span class="trait-label">${traitLabel(board.trait)}</span>
                  <span class="trait-value">${c.value}</span>
                </div>
              </div>
            </div>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function wireGame() {
  $("#abortGame")?.addEventListener("click", () => {
    stopTimer();
    setView("home");
  });
  document.querySelectorAll(".match-card").forEach(node => {
    node.addEventListener("click", () => onCardTap(+node.dataset.idx));
  });
}

function updateHud() {
  const p = $("#hudPairs");   if (p) p.textContent = `${pairsFound} / ${board.pairs}`;
  const s = $("#hudScore");   if (s) s.textContent = score;
  const m = $("#hudMisses");  if (m) m.textContent = misses;
}

function flipCardElement(idx, flipped) {
  const node = document.querySelector(`.match-card[data-idx="${idx}"]`);
  if (!node) return;
  node.classList.toggle("flipped", flipped);
}

function markMatchedElement(idx) {
  const node = document.querySelector(`.match-card[data-idx="${idx}"]`);
  if (!node) return;
  node.classList.add("matched");
}

function onCardTap(idx) {
  if (!board || lockBoard) return;
  const card = board.cards[idx];
  if (!card || card.matched || card.flipped) return;

  card.flipped = true;
  flipCardElement(idx, true);

  if (firstFlipped === null) {
    firstFlipped = idx;
    return;
  }

  // Second flip — resolve.
  const a = board.cards[firstFlipped];
  const b = card;
  const firstIdx = firstFlipped;
  firstFlipped = null;

  if (isMatch(a, b)) {
    a.matched = true; b.matched = true;
    pairsFound += 1;
    const now = performance.now();
    const elapsedSec = (now - lastMatchTime) / 1000;
    const points = scoreMatch(elapsedSec);
    score += points;
    lastMatchTime = now;
    setTimeout(() => {
      markMatchedElement(firstIdx);
      markMatchedElement(idx);
      flashScore(`+${points}`, "good");
      updateHud();
      if (pairsFound === board.pairs) finishGame();
    }, 220);
  } else {
    misses += 1;
    score = Math.max(0, score - missPenalty());
    updateHud();
    flashScore(`-${missPenalty()}`, "bad");
    lockBoard = true;
    setTimeout(() => {
      a.flipped = false; b.flipped = false;
      flipCardElement(firstIdx, false);
      flipCardElement(idx, false);
      lockBoard = false;
    }, 850);
  }
}

function flashScore(text, kind) {
  const el = document.createElement("div");
  el.className = `score-flash ${kind}`;
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 900);
}

let lastResult = null;

function finishGame() {
  stopTimer();
  const totalMs = Math.round(performance.now() - startTime);
  const bonus = completionBonus(board.pairs);
  score += bonus;

  lastResult = {
    score,
    timeMs: totalMs,
    pairs: board.pairs,
    matchTrait: board.trait,
    completionBonus: bonus,
    misses,
    difficulty,
  };

  recordMatchRound(lastResult);

  // Best-effort public leaderboard submit
  submitToLeaderboard("match", {
    score: lastResult.score,
    time: lastResult.timeMs,
    pairs: lastResult.pairs,
    difficulty: lastResult.difficulty,
  }).catch(() => {});

  setTimeout(() => setView("result"), 700);
}

// ---------- RESULT ----------
function renderResult() {
  if (!lastResult) return renderHome();
  const fmt = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
  const stats = getMatchStats();
  const isBestScore = lastResult.score === stats.bestScore && lastResult.score > 0;
  const isBestTime = stats.bestTimeMs === lastResult.timeMs;

  return `
    <section class="play-hero" style="padding-top: 18px;">
      <div class="eyebrow">🎯 Round Complete</div>
      <h1 style="font-size:clamp(48px,8vw,96px); margin: 6px 0;">
        <span class="gradient">${lastResult.score} pts</span>
      </h1>
      <p class="lead" style="max-width: 600px; margin: 0 auto 14px;">
        Found all ${lastResult.pairs} pairs by <b>${traitLabel(lastResult.matchTrait)}</b> in
        <b>${fmt(lastResult.timeMs)}</b>. Misses: <b>${lastResult.misses}</b>.
        Completion bonus: <b>+${lastResult.completionBonus}</b>.
      </p>

      <div class="badge-row">
        ${isBestScore ? `<span class="badge-pill best">🏅 New Best Score</span>` : ""}
        ${isBestTime  ? `<span class="badge-pill best">⏱ New Fastest Time</span>` : ""}
      </div>

      <div class="actions" style="justify-content:center;">
        <button class="btn primary" id="playAgain">▶ Play Again (${DIFFICULTIES[difficulty].label})</button>
        <button class="btn" id="changeDiff">Change Difficulty</button>
        <button class="btn ghost" id="backHome">← Home</button>
      </div>
    </section>

    <section class="section">
      <h2>All-Time Stats</h2>
      <div class="grid-3">
        <div class="feature"><b>${stats.roundsPlayed}</b><p>Rounds Played</p></div>
        <div class="feature"><b>${stats.bestScore}</b><p>Best Score</p></div>
        <div class="feature"><b>${fmt(stats.bestTimeMs ?? 0)}</b><p>Fastest Time</p></div>
      </div>
    </section>
  `;
}

function wireResult() {
  $("#playAgain")?.addEventListener("click", startGame);
  $("#changeDiff")?.addEventListener("click", () => setView("home"));
  $("#backHome")?.addEventListener("click", () => setView("home"));
}

// ---------- render dispatch ----------
function render() {
  const root = $("#matchRoot");
  if (!root) return;
  if (view === "home")   root.innerHTML = renderHome();
  if (view === "game")   root.innerHTML = renderGame();
  if (view === "result") root.innerHTML = renderResult();

  if (view === "home")   wireHome();
  if (view === "game")   wireGame();
  if (view === "result") wireResult();

  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---------- bootstrap ----------
async function init() {
  try {
    manifest = await loadManifest();
    document.addEventListener("wallet:change", () => render());
    setView("home");
  } catch (err) {
    console.error("Match init failed:", err);
    const root = $("#matchRoot");
    if (root) root.innerHTML = `<div style="color:#ffa;padding:24px;text-align:center;">
      Couldn't load NFT data. Check the manifest under /data/.
    </div>`;
  }
}

document.addEventListener("DOMContentLoaded", init);
