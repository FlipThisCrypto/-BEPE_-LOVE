// Landing page: hero carousel, live stats, filterable gallery, scroll card-stack.

import {
  loadManifest, loadStats, tierClass, elementClass, topByPoints, pickRandom,
} from "./data.js";

const FEATURED_COUNT = 9;     // hero carousel
const STACK_COUNT = 6;        // scroll-stack section
const PAGE_SIZE = 36;         // gallery batch

let manifest = [];
let featured = [];
let galleryFilter = "All";
let galleryRendered = 0;
let galleryPool = [];

// ---------- hero stats ----------
function renderStats(stats) {
  const root = document.getElementById("heroStats");
  if (!root) return;
  const items = [
    { val: stats.count.toLocaleString(), label: "Bepes" },
    { val: stats.max_points, label: "Top Power" },
    { val: stats.tier_counts["Tang Lord"], label: "Tang Lords" },
    { val: "Chia", label: "NFT Chain" },
  ];
  root.innerHTML = items.map(i => `
    <div class="stat"><strong>${i.val}</strong><span>${i.label}</span></div>
  `).join("");
}

// ---------- hero carousel ----------
let carouselIndex = 0;
let autoSpin = true;
let timer = null;

function buildCarousel() {
  const el = document.getElementById("carousel");
  if (!el) return;
  el.innerHTML = "";
  featured.forEach((nft) => {
    const card = document.createElement("div");
    card.className = "character-card";
    card.innerHTML = `
      <img src="${nft.card}" alt="${nft.name}" loading="lazy" />
      <div class="meta">
        <span class="tier ${tierClass(nft.tier)}">${nft.tier}</span>
        <span class="points-badge">${nft.points} PTS</span>
      </div>
    `;
    el.appendChild(card);
  });
  updateCarousel();
}

function updateCarousel() {
  const cards = [...document.querySelectorAll(".character-card")];
  cards.forEach((card, idx) => {
    card.classList.remove("active", "left", "right", "back");
    const diff = (idx - carouselIndex + cards.length) % cards.length;
    if (diff === 0) card.classList.add("active");
    else if (diff === 1) card.classList.add("right");
    else if (diff === cards.length - 1) card.classList.add("left");
    else card.classList.add("back");
  });
}

function move(direction) {
  carouselIndex = (carouselIndex + direction + featured.length) % featured.length;
  updateCarousel();
}

function randomSpin() {
  stopAutoSpin(false);
  let count = 0;
  const total = 12 + Math.floor(Math.random() * 12);
  const spin = setInterval(() => {
    move(1);
    count++;
    if (count >= total) {
      clearInterval(spin);
      if (autoSpin) startAutoSpin();
    }
  }, 90);
}

function startAutoSpin() {
  stopAutoSpin(false);
  timer = setInterval(() => move(1), 2600);
  const badge = document.getElementById("spinBadge");
  if (badge) badge.textContent = "Free Spinning";
  const btn = document.getElementById("autoBtn");
  if (btn) btn.textContent = "Free Spin: On";
}

function stopAutoSpin(setOff = true) {
  if (timer) { clearInterval(timer); timer = null; }
  if (setOff) {
    const badge = document.getElementById("spinBadge");
    if (badge) badge.textContent = "Paused";
    const btn = document.getElementById("autoBtn");
    if (btn) btn.textContent = "Free Spin: Off";
  }
}

function toggleAutoSpin() {
  autoSpin = !autoSpin;
  if (autoSpin) startAutoSpin();
  else stopAutoSpin(true);
}

// ---------- gallery ----------
function applyFilter() {
  if (galleryFilter === "All") {
    galleryPool = manifest.slice();
  } else if (galleryFilter.startsWith("tier:")) {
    const tier = galleryFilter.slice(5);
    galleryPool = manifest.filter(n => n.tier === tier);
  } else if (galleryFilter.startsWith("el:")) {
    const el = galleryFilter.slice(3);
    galleryPool = manifest.filter(n => n.element === el);
  }
  // Featured-style sort: rarest first when filtered, otherwise pseudo-shuffled.
  if (galleryFilter === "All") {
    galleryPool.sort((a, b) => a.id - b.id);
  } else {
    galleryPool.sort((a, b) => a.rank - b.rank);
  }
  galleryRendered = 0;
  const grid = document.getElementById("galleryGrid");
  if (grid) grid.innerHTML = "";
  renderGalleryBatch();
}

function renderGalleryBatch() {
  const grid = document.getElementById("galleryGrid");
  if (!grid) return;
  const slice = galleryPool.slice(galleryRendered, galleryRendered + PAGE_SIZE);
  const frag = document.createDocumentFragment();
  for (const nft of slice) {
    const a = document.createElement("button");
    a.className = "thumb";
    a.title = `${nft.name} — ${nft.tier} • ${nft.points} pts`;
    a.innerHTML = `
      <img src="${nft.thumb}" alt="${nft.name}" loading="lazy" />
      <span class="corner tier ${tierClass(nft.tier)}">${nft.tier}</span>
      <span class="pts">${nft.points}</span>
    `;
    a.addEventListener("click", () => {
      // Jump this NFT into the hero carousel.
      const fIdx = featured.findIndex(f => f.id === nft.id);
      if (fIdx >= 0) {
        carouselIndex = fIdx;
      } else {
        featured[0] = nft;
        carouselIndex = 0;
        buildCarousel();
      }
      updateCarousel();
      document.getElementById("hero")?.scrollIntoView({ behavior: "smooth" });
    });
    frag.appendChild(a);
  }
  grid.appendChild(frag);
  galleryRendered += slice.length;

  const status = document.getElementById("galleryStatus");
  if (status) {
    status.textContent = `Showing ${galleryRendered.toLocaleString()} of ${galleryPool.length.toLocaleString()}`;
  }
  const more = document.getElementById("galleryMore");
  if (more) more.style.display = galleryRendered >= galleryPool.length ? "none" : "inline-flex";
}

function wireGalleryControls() {
  document.querySelectorAll("#galleryFilters .chip").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("#galleryFilters .chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      galleryFilter = chip.dataset.filter;
      applyFilter();
    });
  });
  document.getElementById("galleryMore")?.addEventListener("click", renderGalleryBatch);
}

// ---------- scroll card-stack ----------
function buildStack() {
  const root = document.getElementById("stack");
  if (!root) return;
  const picks = topByPoints(manifest, STACK_COUNT);
  root.innerHTML = picks.map((nft, i) => `
    <div class="stack-card" style="top: ${80 + i * 24}px;">
      <img src="${nft.card}" alt="${nft.name}" loading="lazy" />
      <div class="body">
        <div>
          <div class="title">${nft.name}</div>
          <div class="sub">Rank #${nft.rank}</div>
        </div>
        <div style="display:flex; gap:6px; flex-direction:column; align-items:flex-end;">
          <span class="tier ${tierClass(nft.tier)}">${nft.tier}</span>
          <span class="points-badge">${nft.points} PTS</span>
        </div>
      </div>
    </div>
  `).join("");
}

// ---------- audio toggle ----------
function wireAudio() {
  const btn = document.getElementById("audioToggle");
  const audio = document.getElementById("bgAudio");
  if (!btn || !audio) return;
  let playing = false;
  btn.addEventListener("click", async () => {
    try {
      if (playing) { audio.pause(); btn.textContent = "♪"; }
      else { await audio.play(); btn.textContent = "❚❚"; }
      playing = !playing;
    } catch (err) {
      console.warn("Audio playback blocked:", err);
    }
  });
}

// ---------- bootstrap ----------
async function init() {
  try {
    const [m, s] = await Promise.all([loadManifest(), loadStats()]);
    manifest = m;
    renderStats(s);

    // The wallet button is owned by wallet-ui.js — landing just listens so
    // future per-wallet hero pieces (e.g., "your collection: N Bepes") have
    // a hook to plug into.
    document.addEventListener("wallet:change", (e) => {
      // No-op for now; reserved.
    });

    // Featured = top 9 rarest for hero
    featured = topByPoints(manifest, FEATURED_COUNT);
    buildCarousel();
    startAutoSpin();

    galleryPool = manifest.slice();
    renderGalleryBatch();
    wireGalleryControls();
    buildStack();
    wireAudio();

    // Expose for inline onclick handlers in HTML
    window.move = move;
    window.randomSpin = randomSpin;
    window.toggleAutoSpin = toggleAutoSpin;
  } catch (err) {
    console.error("Init failed:", err);
    const carousel = document.getElementById("carousel");
    if (carousel) {
      carousel.innerHTML = `<div style="color:#ffa;padding:18px;text-align:center;">
        Couldn't load NFT data. Run <code>python scripts/build_manifest.py</code>?
      </div>`;
    }
  }
}

document.addEventListener("DOMContentLoaded", init);
