// Bepe Brawl UI controller. State machine: home -> pick -> battle -> result.
// Talks to brawl-engine for resolution and score-store for persistence.

import { loadManifest, tierClass, elementClass, pickRandom } from "./data.js";
import { runMatch, draftOpponentHand } from "./brawl-engine.js";
import { recordBrawlMatch, getBrawlStats, getProfile, setProfileName } from "./score-store.js";
import { getAddressInfo, getCurrentBech32Address } from "./wallet.js";
import { getOwnedBepeRecords } from "./indexer.js";

let manifest = [];
let view = "home";              // home | pick | battle | result
let yourHand = [];
let lastMatch = null;           // result of latest runMatch
let pickFilter = "All";
let ownedIds = null;            // Set<number> of Bepes the connected wallet owns, null if unknown

// ---------- helpers ----------
function $(sel) { return document.querySelector(sel); }
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function cardThumb(nft, opts = {}) {
  const { compact = false } = opts;
  return `
    <div class="game-card${compact ? " compact" : ""}">
      <img src="${nft.card}" alt="${nft.name}" loading="lazy" />
      <div class="strip">
        <span class="tier ${tierClass(nft.tier)}">${nft.tier}</span>
        <span class="element ${elementClass(nft.element)}">${nft.element}</span>
      </div>
      <div class="body">
        <div class="name">${nft.name}</div>
        <div class="row">
          <span class="rank-mini">#${nft.rank}</span>
          <span class="points-badge">${nft.points} PTS</span>
        </div>
      </div>
    </div>
  `;
}

function setView(next) {
  view = next;
  render();
}

// ---------- HOME ----------
function renderHome() {
  const stats = getBrawlStats();
  const profile = getProfile();
  const winRate = stats.matches ? Math.round((stats.wins / stats.matches) * 100) : 0;

  return `
    <section class="play-hero">
      <div class="eyebrow">Auto-Battler · Live</div>
      <h1><span class="gradient">Bepe Brawl</span></h1>
      <p class="lead">
        Pick three Bepes. Three rounds. Power vs. power, with elemental matchups
        and trait abilities firing in real time. Anyone can play.
      </p>

      <div class="actions" style="justify-content:center;">
        <button class="btn primary" id="quickBrawl">⚡ Quick Brawl (Random Hand)</button>
        <button class="btn" id="pickHand">🎴 Pick Your Hand</button>
      </div>

      <div class="profile-row">
        <label class="profile-label" for="profileName">Brawler name</label>
        <input type="text" id="profileName" maxlength="24"
          placeholder="Anonymous Bepe" value="${profile.name ?? ""}" />
      </div>
    </section>

    <section class="section" id="leaderboard">
      <h2>Your Record</h2>
      <div class="grid-3">
        <div class="feature"><b>${stats.matches}</b><p>Matches Played</p></div>
        <div class="feature"><b>${stats.wins}–${stats.losses}–${stats.draws}</b><p>W–L–D · ${winRate}%</p></div>
        <div class="feature"><b>${stats.longestStreak}</b><p>Longest Streak (Current: ${stats.currentStreak})</p></div>
      </div>
      ${stats.history.length ? `
        <h3 style="margin-top:24px;">Recent Brawls</h3>
        <ul class="history">
          ${stats.history.slice(0, 6).map(h => {
            const mark = h.outcome === "win" ? "🏆" : h.outcome === "loss" ? "💀" : "🤝";
            const date = new Date(h.ts).toLocaleString();
            const summary = h.rounds.map(r => `${r.youScore}-${r.oppScore}`).join(" · ");
            return `<li><span class="mark">${mark}</span><span class="when">${date}</span><span class="rounds">${summary}</span></li>`;
          }).join("")}
        </ul>
      ` : `<p style="color:var(--ink-2); margin-top:18px;">No matches yet — hit Quick Brawl above.</p>`}
    </section>

    <section class="section">
      <h2>How a brawl plays out</h2>
      <div class="grid-3">
        <div class="feature"><b>1. Draft</b><p>Pick three Bepes from the collection — or roll a random hand.</p></div>
        <div class="feature"><b>2. Resolve</b><p>Each round: power + element bonus + ability triggers. Best of three takes the match.</p></div>
        <div class="feature"><b>3. Climb</b><p>Wins persist locally. Wallet-linked leaderboards arrive with Chia connect.</p></div>
      </div>
      <div class="grid-3" style="margin-top: 14px;">
        <div class="feature">
          <b>Element Wheel</b>
          <p>🔥 Fire beats 🌿 Nature beats 💧 Water beats 🔥 Fire. ✨ Light and 🔮 Arcane clash for high stakes.</p>
        </div>
        <div class="feature">
          <b>Trait Abilities</b>
          <p>Foundation Halo +20 self · Asters Wand +25 self · FOMO Flame Patch -15 opp · Lasers +30 self...</p>
        </div>
        <div class="feature">
          <b>Power = Points</b>
          <p>The base score every Bepe brings to the round. Higher tiers carry more raw weight.</p>
        </div>
      </div>
    </section>
  `;
}

function wireHome() {
  $("#quickBrawl")?.addEventListener("click", quickBrawl);
  $("#pickHand")?.addEventListener("click", () => setView("pick"));
  $("#profileName")?.addEventListener("change", (e) => setProfileName(e.target.value));
}

function quickBrawl() {
  yourHand = pickRandom(manifest, 3);
  startBattle();
}

// ---------- PICK ----------
function renderPick() {
  const filtered = filteredPool();
  return `
    <section class="play-hero" style="margin-bottom:20px;">
      <div class="eyebrow">Step 1 of 2 · Pick Your Hand</div>
      <h1 style="font-size:clamp(36px,6vw,64px); margin: 6px 0 14px;">Pick three Bepes</h1>
      <p class="lead" style="font-size:16px; max-width:640px; margin:0 auto 18px;">
        Tap three to draft your hand. Slot order is fixed — slot 1 vs. slot 1, slot 2 vs. slot 2, slot 3 vs. slot 3.
      </p>
    </section>

    <section class="section" style="padding:22px;">
      <div class="hand-bar">
        <div class="hand-slots" id="handSlots">
          ${[0, 1, 2].map(i => {
            const c = yourHand[i];
            return `
              <div class="hand-slot ${c ? "filled" : ""}" data-slot="${i}">
                ${c ? `
                  <img src="${c.thumb}" alt="${c.name}" />
                  <span class="slot-label">${c.tier}</span>
                  <button class="slot-remove" data-remove="${i}" aria-label="Remove">×</button>
                ` : `<span class="slot-label">Slot ${i + 1}</span>`}
              </div>
            `;
          }).join("")}
        </div>
        <div class="hand-actions">
          <button class="btn ghost" id="randomFill">🎲 Random Fill</button>
          <button class="btn ghost" id="clearHand">Clear</button>
          <button class="btn primary" id="goBrawl" ${yourHand.length === 3 ? "" : "disabled"}>
            ${yourHand.length === 3 ? "⚔ Brawl!" : `${yourHand.length}/3 picked`}
          </button>
          <button class="btn ghost" id="backHome">← Back</button>
        </div>
      </div>

      <div class="gallery-controls" id="pickFilters" style="margin-top:18px;">
        ${getAddressInfo() ? `<span class="chip owned ${pickFilter === "owned" ? "active" : ""}" data-filter="owned">⭐ My Bepes${ownedIds ? ` (${ownedIds.size})` : "…"}</span>` : ""}
        <span class="chip ${pickFilter === "All" ? "active" : ""}" data-filter="All">All</span>
        <span class="chip ${pickFilter === "tier:Tang Lord"  ? "active" : ""}" data-filter="tier:Tang Lord">Tang Lord</span>
        <span class="chip ${pickFilter === "tier:Tang Mage"  ? "active" : ""}" data-filter="tier:Tang Mage">Tang Mage</span>
        <span class="chip ${pickFilter === "tier:Wizard"     ? "active" : ""}" data-filter="tier:Wizard">Wizard</span>
        <span class="chip ${pickFilter === "tier:Apprentice" ? "active" : ""}" data-filter="tier:Apprentice">Apprentice</span>
        <span class="chip ${pickFilter === "tier:Pleb"       ? "active" : ""}" data-filter="tier:Pleb">Pleb</span>
        <span class="chip ${pickFilter === "el:Fire"   ? "active" : ""}" data-filter="el:Fire">🔥 Fire</span>
        <span class="chip ${pickFilter === "el:Water"  ? "active" : ""}" data-filter="el:Water">💧 Water</span>
        <span class="chip ${pickFilter === "el:Nature" ? "active" : ""}" data-filter="el:Nature">🌿 Nature</span>
        <span class="chip ${pickFilter === "el:Light"  ? "active" : ""}" data-filter="el:Light">✨ Light</span>
        <span class="chip ${pickFilter === "el:Arcane" ? "active" : ""}" data-filter="el:Arcane">🔮 Arcane</span>
      </div>

      ${pickFilter === "owned" && filtered.length === 0 ? `
        <div class="owned-empty">
          ${ownedIds == null ? "Looking up your Bepes…" : "No Bepe Loves in this wallet yet. Mint or pick from the full collection above."}
        </div>
      ` : ""}

      <div class="pick-grid" id="pickGrid">
        ${filtered.slice(0, 60).map(nft => {
          const picked = yourHand.find(c => c.id === nft.id);
          return `
            <button class="pick-thumb${picked ? " picked" : ""}" data-id="${nft.id}" title="${nft.name} · ${nft.points} pts">
              <img src="${nft.thumb}" alt="${nft.name}" loading="lazy" />
              <span class="corner tier ${tierClass(nft.tier)}">${nft.tier}</span>
              <span class="pts">${nft.points}</span>
            </button>
          `;
        }).join("")}
      </div>
      <div class="gallery-status">
        Showing ${Math.min(60, filtered.length).toLocaleString()} of ${filtered.length.toLocaleString()}
        ${filtered.length > 60 ? "(showing top 60 by rank — apply a filter to drill in)" : ""}
      </div>
    </section>
  `;
}

function filteredPool() {
  let pool = manifest.slice();
  if (pickFilter === "owned" && ownedIds) {
    pool = pool.filter(n => ownedIds.has(n.id));
  } else if (pickFilter.startsWith("tier:")) {
    const tier = pickFilter.slice(5);
    pool = pool.filter(n => n.tier === tier);
  } else if (pickFilter.startsWith("el:")) {
    const el = pickFilter.slice(3);
    pool = pool.filter(n => n.element === el);
  }
  pool.sort((a, b) => a.rank - b.rank);
  return pool;
}

async function refreshOwned() {
  const info = getAddressInfo();
  if (!info) { ownedIds = null; return; }
  try {
    const addr = await getCurrentBech32Address();
    if (!addr) { ownedIds = new Set(); return; }
    const records = await getOwnedBepeRecords(addr);
    ownedIds = new Set(records.map(r => r.id));
  } catch (err) {
    console.warn("Owned-Bepes lookup failed:", err);
    ownedIds = new Set();
  }
}

function wirePick() {
  $("#backHome")?.addEventListener("click", () => setView("home"));
  $("#clearHand")?.addEventListener("click", () => { yourHand = []; render(); });
  $("#randomFill")?.addEventListener("click", () => {
    const need = 3 - yourHand.length;
    if (need <= 0) return;
    const used = new Set(yourHand.map(c => c.id));
    const picks = pickRandom(manifest.filter(c => !used.has(c.id)), need);
    yourHand = yourHand.concat(picks);
    render();
  });
  $("#goBrawl")?.addEventListener("click", () => {
    if (yourHand.length === 3) startBattle();
  });
  document.querySelectorAll("#pickFilters .chip").forEach(chip => {
    chip.addEventListener("click", () => { pickFilter = chip.dataset.filter; render(); });
  });
  document.querySelectorAll(".pick-thumb").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = +btn.dataset.id;
      const idx = yourHand.findIndex(c => c.id === id);
      if (idx >= 0) {
        yourHand.splice(idx, 1);
      } else if (yourHand.length < 3) {
        yourHand.push(manifest.find(c => c.id === id));
      }
      render();
    });
  });
  document.querySelectorAll("[data-remove]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const i = +btn.dataset.remove;
      yourHand.splice(i, 1);
      render();
    });
  });
}

// ---------- BATTLE ----------
let battleState = null;       // { oppHand, match, currentRound, animating }

function startBattle() {
  const oppHand = draftOpponentHand(manifest, yourHand);
  const match = runMatch(yourHand, oppHand);
  battleState = { oppHand, match, currentRound: -1, animating: false };
  setView("battle");
  // Kick off animations after the DOM lands.
  setTimeout(() => animateNextRound(), 350);
}

function renderBattle() {
  if (!battleState) return "";
  const { oppHand, match, currentRound } = battleState;
  return `
    <section class="play-hero" style="margin-bottom:14px; padding-top:12px;">
      <div class="eyebrow">Brawl in progress</div>
      <h1 style="font-size:clamp(34px,5vw,56px); margin: 4px 0 0;">
        <span class="gradient">Bepe Brawl</span>
      </h1>
    </section>

    <section class="section battle-arena">
      <div class="arena-side opp">
        <div class="side-label">OPPONENT <span class="opp-name">House Bepe</span></div>
        <div class="hand-row">
          ${oppHand.map((c, i) => `
            <div class="arena-card${currentRound === i ? " active" : ""}${currentRound > i ? " done" : ""}" data-side="opp" data-round="${i}">
              ${currentRound >= i ? cardThumb(c, { compact: true }) : `
                <div class="card-back">
                  <div class="rune">✦</div>
                </div>
              `}
            </div>
          `).join("")}
        </div>
      </div>

      <div class="round-strip" id="roundStrip">
        ${match.rounds.map((r, i) => {
          const status = currentRound > i ? (r.winner === "you" ? "you" : r.winner === "opp" ? "opp" : "draw")
                       : currentRound === i ? "live" : "pending";
          const score = currentRound >= i ? `${r.yourScore} – ${r.oppScore}` : "—";
          return `
            <div class="round-cell status-${status}">
              <div class="round-label">R${i + 1}</div>
              <div class="round-score">${score}</div>
              <div class="round-flavor">${currentRound >= i ? flavorFor(r) : ""}</div>
            </div>
          `;
        }).join("")}
      </div>

      <div class="arena-side you">
        <div class="side-label">YOU <span class="you-name">${getProfile().name ?? "Anonymous Bepe"}</span></div>
        <div class="hand-row">
          ${yourHand.map((c, i) => `
            <div class="arena-card${currentRound === i ? " active" : ""}${currentRound > i ? " done" : ""}" data-side="you" data-round="${i}">
              ${cardThumb(c, { compact: true })}
            </div>
          `).join("")}
        </div>
      </div>

      <div class="battle-actions">
        <button class="btn ghost" id="skipAnim">⏭ Skip to result</button>
      </div>
    </section>
  `;
}

function flavorFor(round) {
  const bits = [];
  if (round.elementBonus.kind === "advantage") bits.push("⚡ element");
  else if (round.elementBonus.kind === "disadvantage") bits.push("💢 outmatched");
  else if (round.elementBonus.kind === "clash") bits.push("✨ clash");
  else if (round.elementBonus.kind === "mirror") bits.push("🪞 mirror");
  if (round.yourAbilities.length) bits.push("🔥");
  return bits.join(" · ") || "—";
}

function wireBattle() {
  $("#skipAnim")?.addEventListener("click", () => {
    if (!battleState) return;
    battleState.currentRound = 3;
    finishBattle();
  });
}

function animateNextRound() {
  if (!battleState) return;
  battleState.currentRound += 1;
  if (battleState.currentRound >= 3) {
    finishBattle();
    return;
  }
  // Re-render with the new round revealed.
  render();
  setTimeout(animateNextRound, 1700);
}

function finishBattle() {
  const { match, oppHand } = battleState;
  // Persist
  const summary = {
    outcome: match.outcome,
    bestRoundDelta: match.bestRoundDelta,
    you: yourHand.map(c => ({ id: c.id, name: c.name, points: c.points, tier: c.tier, element: c.element })),
    opp: oppHand.map(c => ({ id: c.id, name: c.name, points: c.points, tier: c.tier, element: c.element })),
    rounds: match.rounds.map(r => ({ youScore: r.yourScore, oppScore: r.oppScore, winner: r.winner })),
  };
  recordBrawlMatch(summary);
  lastMatch = { match, oppHand };
  setView("result");
}

// ---------- RESULT ----------
function renderResult() {
  if (!lastMatch) return renderHome();
  const { match, oppHand } = lastMatch;
  const stats = getBrawlStats();
  const banner = match.outcome === "win" ? { title: "Victory", emoji: "🏆", cls: "win" }
               : match.outcome === "loss" ? { title: "Defeat",  emoji: "💀", cls: "loss" }
               : { title: "Draw", emoji: "🤝", cls: "draw" };

  return `
    <section class="play-hero" style="padding-top:18px;">
      <div class="eyebrow">${banner.emoji} Round ${match.yWins}–${match.oWins}</div>
      <h1 class="result-banner ${banner.cls}" style="font-size:clamp(48px,8vw,96px); margin:6px 0;">
        <span class="gradient">${banner.title}</span>
      </h1>
      <p class="lead" style="max-width:560px; margin:0 auto 18px;">
        Best round delta: <b>${match.bestRoundDelta} pts</b>.
        Streak: <b>${stats.currentStreak}</b>. Longest: <b>${stats.longestStreak}</b>.
      </p>
      <div class="actions" style="justify-content:center;">
        <button class="btn primary" id="brawlAgain">⚡ Brawl Again (Quick)</button>
        <button class="btn" id="pickAgain">🎴 Pick a New Hand</button>
        <button class="btn ghost" id="backToHome">← Home</button>
      </div>
    </section>

    <section class="section">
      <h2>Round-by-round</h2>
      <div class="round-detail">
        ${match.rounds.map((r, i) => `
          <div class="round-detail-card winner-${r.winner}">
            <div class="round-detail-head">
              <span class="round-num">Round ${i + 1}</span>
              <span class="round-result">${r.yourScore} – ${r.oppScore}</span>
            </div>
            <div class="vs-row">
              <div class="vs-side">${cardThumb(r.yourCard, { compact: true })}</div>
              <div class="vs-mid">
                <div class="vs-arrow">⚔</div>
                <div class="vs-flavor">${flavorFor(r) || "even fight"}</div>
              </div>
              <div class="vs-side">${cardThumb(r.oppCard, { compact: true })}</div>
            </div>
            <div class="round-breakdown">
              ${roundBreakdown(r)}
            </div>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function roundBreakdown(r) {
  const lines = [];
  lines.push(`Base: ${r.yourCard.points} vs ${r.oppCard.points}`);
  if (r.elementBonus.you || r.elementBonus.opp) {
    lines.push(`Element ${r.elementBonus.kind}: +${r.elementBonus.you} / +${r.elementBonus.opp}`);
  }
  for (const a of r.yourAbilities) lines.push(`You · ${a.label}`);
  for (const a of r.oppAbilities) lines.push(`Opp · ${a.label}`);
  return lines.map(l => `<div class="bd-line">${l}</div>`).join("");
}

function wireResult() {
  $("#brawlAgain")?.addEventListener("click", () => { yourHand = pickRandom(manifest, 3); startBattle(); });
  $("#pickAgain")?.addEventListener("click", () => { yourHand = []; setView("pick"); });
  $("#backToHome")?.addEventListener("click", () => setView("home"));
}

// ---------- render dispatch ----------
function render() {
  const root = $("#playRoot");
  if (!root) return;
  if (view === "home")    root.innerHTML = renderHome();
  if (view === "pick")    root.innerHTML = renderPick();
  if (view === "battle")  root.innerHTML = renderBattle();
  if (view === "result")  root.innerHTML = renderResult();

  if (view === "home")    wireHome();
  if (view === "pick")    wirePick();
  if (view === "battle")  wireBattle();
  if (view === "result")  wireResult();

  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---------- bootstrap ----------
async function init() {
  try {
    manifest = await loadManifest();
    document.addEventListener("wallet:change", async () => {
      ownedIds = null;
      // Trigger lookup; re-render whichever view is active when it lands.
      await refreshOwned();
      render();
    });
    // If a session was restored at boot, kick off the lookup now.
    if (getAddressInfo()) refreshOwned().then(() => render());
    setView("home");
  } catch (err) {
    console.error("Brawl init failed:", err);
    const root = $("#playRoot");
    if (root) root.innerHTML = `<div style="color:#ffa;padding:24px;text-align:center;">
      Couldn't load NFT data. Check the manifest under /data/.
    </div>`;
  }
}

document.addEventListener("DOMContentLoaded", init);
