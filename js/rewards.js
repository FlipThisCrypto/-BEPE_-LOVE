// Bepe Love Rewards — frontend integrated into the main site.
//
// Reuses the site's wallet.js for WalletConnect (one shared session across
// mint + brawl + match + rewards). Talks to the Cloudflare Worker for epoch
// math, claim challenges, and broadcast.
//
// The Worker URL is read from <meta name="rewards-api">. Falls back to the
// production URL.

import { getAddressInfo, getCurrentBech32Address, requestRpc, onChange } from "./wallet.js";

const API_BASE = (
  document.querySelector('meta[name="rewards-api"]')?.content?.trim() ||
  "https://bepe-rewards.bepelove.workers.dev"
);

const SPACESCAN_BASE = "https://www.spacescan.io/address/";
const MOJO_PER_XCH = 1_000_000_000_000n;
const BIG_PREFIX = "$bigint:";

let config = null;
let walletAddr = null;

// ---------- helpers ----------

function reviveBigInts(_k, v) {
  return typeof v === "string" && v.startsWith(BIG_PREFIX)
    ? BigInt(v.slice(BIG_PREFIX.length))
    : v;
}

async function api(path) {
  const res = await fetch(`${API_BASE}${path}`);
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error ?? text; } catch {}
    throw new Error(`API ${res.status}: ${msg}`);
  }
  return JSON.parse(text, reviveBigInts);
}

function fmtXch(mojo) {
  if (typeof mojo !== "bigint") mojo = BigInt(mojo ?? 0);
  const whole = mojo / MOJO_PER_XCH;
  const frac = (mojo % MOJO_PER_XCH).toString().padStart(12, "0").slice(0, 6);
  const trimmed = frac.replace(/0+$/, "");
  return trimmed.length ? `${whole}.${trimmed}` : `${whole}`;
}

function shortAddr(a) {
  return a && a.length > 18 ? `${a.slice(0, 10)}…${a.slice(-6)}` : (a || "");
}

function $(id) { return document.getElementById(id); }
function setText(id, t) { const e = $(id); if (e) e.textContent = t; }
function setHidden(id, h) { const e = $(id); if (e) e.hidden = h; }

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function stripHexPrefix(s) {
  return typeof s === "string" && s.startsWith("0x") ? s.slice(2) : s;
}

// ---------- address resolution ----------
// wallet.js's getCurrentBech32Address now tries chia_getAddress (Sage) then
// chia_getCurrentAddress (reference wallet) internally, so a single call
// here covers both wallets.

async function resolveWalletAddress() {
  const info = getAddressInfo();
  if (!info) return null;
  return await getCurrentBech32Address().catch(() => null);
}

// ---------- bootstrap ----------

async function init() {
  // Bind UI handlers BEFORE awaiting any slow network calls.
  $("refreshBtn")?.addEventListener("click", () => walletAddr && loadClaim(walletAddr));
  $("claimBtn")?.addEventListener("click", onClaimClick);

  // Wallet state changes (connect/disconnect from anywhere on the site).
  document.addEventListener("wallet:change", () => onWalletChange());
  onChange(() => onWalletChange());

  // Fetch config (tier table, addresses, phase). Has to succeed.
  try {
    config = await api("/config");
  } catch (err) {
    showFatal(`Couldn't reach the rewards Worker — ${err.message}`);
    return;
  }

  renderTierTable(config.tiers);
  setText("poolAddr", config.poolAddress || "—");
  if (config.poolAddress) {
    $("poolLink").href = SPACESCAN_BASE + config.poolAddress;
  }
  if (config.payoutAddress) {
    setText("payoutAddr", config.payoutAddress);
    $("payoutLink").href = SPACESCAN_BASE + config.payoutAddress;
  } else {
    setText("payoutAddr", "(not configured yet)");
  }

  if (config.phase === 2) {
    const badge = $("phaseBadge");
    if (badge) {
      badge.textContent = "Phase 2 · live claims";
      badge.classList.add("live");
    }
  }

  // Async loads — don't block the page render.
  loadEpochsDashboard().catch(err => console.error("epoch dashboard load failed:", err));
  loadStats().catch(() => {});

  // If a wallet is already connected (e.g., from the mint flow), kick off the claim lookup.
  if (getAddressInfo()) onWalletChange();
}

function showFatal(msg) {
  const list = $("epochList");
  if (list) list.innerHTML = `<div class="epoch-row error">${escapeHtml(msg)}</div>`;
}

// ---------- dashboard ----------

async function loadEpochsDashboard() {
  let data;
  try {
    data = await api("/epochs");
  } catch (err) {
    showFatal(`Couldn't load epochs: ${err.message}`);
    return;
  }

  setText("kpiEpoch", data.currentEpoch >= 0 ? `#${data.currentEpoch}` : "pre-genesis");
  const cur = data.epochs.find(e => e.epoch === data.currentEpoch);
  if (cur && !cur.error) {
    setText("kpiCurXch", fmtXch(cur.totalMojo));
    setText("kpiEpochWindow", `blocks ${cur.window.startBlock.toLocaleString()}–${cur.window.endBlock.toLocaleString()}`);
  } else if (data.currentEpoch < 0 && config) {
    setText("kpiEpochWindow", `genesis at block ${config.genesisBlock.toLocaleString()}`);
    setText("kpiCurXch", "0");
  }

  if (data.lastClosedEpoch >= 0) {
    setText("kpiLastClosed", `#${data.lastClosedEpoch}`);
    const last = data.epochs.find(e => e.epoch === data.lastClosedEpoch);
    if (last && !last.error) setText("kpiLastClosedXch", `${fmtXch(last.totalMojo)} XCH`);
  } else {
    setText("kpiLastClosed", "—");
    setText("kpiLastClosedXch", "no epoch closed yet");
  }

  const list = $("epochList");
  if (!list) return;
  list.innerHTML = "";
  for (const e of data.epochs) {
    const row = document.createElement("div");
    row.className = "epoch-row";
    const status = e.error ? "error" : (e.status ?? "closed");
    row.innerHTML = `
      <div class="epoch-num">epoch #${e.epoch}</div>
      <div class="epoch-blocks">blk ${e.window.startBlock.toLocaleString()}–${e.window.endBlock.toLocaleString()}</div>
      <div class="epoch-amt">${e.error ? "—" : fmtXch(e.totalMojo)} XCH</div>
      <div class="epoch-status status-${status}">${status.replace("_", " ")}</div>
    `;
    list.appendChild(row);
  }
}

function renderTierTable(tiers) {
  const tbody = document.querySelector("#tierTable tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  const TIER_CLS = {
    Mythic: "tang-lord",
    Legendary: "tang-mage",
    Epic: "wizard",
    Rare: "wizard",
    Uncommon: "apprentice",
    Common: "pleb",
  };
  for (const t of tiers) {
    const tr = document.createElement("tr");
    const cls = TIER_CLS[t.name] || "";
    tr.innerHTML = `
      <td><span class="tier ${cls}">${t.name}</span></td>
      <td>${t.rankMin}–${t.rankMax}</td>
      <td>${(t.rankMax - t.rankMin + 1).toLocaleString()}</td>
      <td class="pct">${(t.poolPercentBps / 100).toFixed(0)}%</td>
    `;
    tbody.appendChild(tr);
  }
}

// ---------- wallet integration ----------

async function onWalletChange() {
  const info = getAddressInfo();
  if (!info) {
    walletAddr = null;
    setHidden("claimCard", true);
    setHidden("connectPrompt", false);
    const btn = $("claimBtn");
    if (btn) { btn.disabled = true; btn.textContent = "⚡ Claim"; }
    return;
  }

  // Resolve the actual xch1 address — required for /claimable lookup
  walletAddr = await resolveWalletAddress();
  if (!walletAddr) {
    showClaimFatal("Couldn't determine your wallet's xch1 address. Your wallet may not have approved chia_getCurrentAddress / chia_getAddress at pairing — try disconnecting and reconnecting.");
    return;
  }

  setHidden("connectPrompt", true);
  setHidden("claimCard", false);
  const btn = $("claimBtn");
  if (btn) {
    btn.disabled = config?.phase !== 2;
    btn.title = config?.phase === 2
      ? "Sign a one-time message to claim your rewards"
      : "Phase 1 — audit only. Claim button activates in Phase 2.";
  }
  loadClaim(walletAddr);
  loadStats(walletAddr).catch(() => {});
}

function showClaimFatal(msg) {
  setHidden("connectPrompt", true);
  setHidden("claimCard", false);
  setText("claimTotal", "—");
  $("claimDetail").innerHTML = `<p class="muted">${escapeHtml(msg)}</p>`;
}

// ---------- claim ----------

async function loadClaim(wallet) {
  if (!wallet) return;
  setText("claimTotal", "…");
  $("claimDetail").innerHTML = "";
  setText("claimNote", "Computing from on-chain history. First-time epoch snapshots can take 5-15 seconds.");

  try {
    const res = await api(`/claimable?wallet=${encodeURIComponent(wallet)}`);
    setText("claimTotal", fmtXch(res.totalOwedMojo));

    const detail = $("claimDetail");
    detail.innerHTML = "";
    if (!res.lines || !res.lines.length) {
      detail.innerHTML = `<p class="muted">No claimable rewards yet for this wallet. Either no Bepes were held at any closed epoch's snapshot, or no income arrived in those epochs.</p>`;
    } else {
      for (const line of res.lines) {
        const breakdown = line.perTier
          .filter(t => t.nftsHeld > 0)
          .map(t => `${t.nftsHeld}× ${t.tier}`)
          .join(" · ");
        const div = document.createElement("div");
        div.className = `claim-line${line.expired ? " expired" : ""}`;
        div.innerHTML = `
          <div class="claim-line-ep">#${line.epoch}</div>
          <div class="claim-line-detail">${escapeHtml(breakdown || "no holdings this epoch")}${line.expired ? " · expired" : ""}</div>
          <div class="claim-line-owed">${fmtXch(line.owedMojo)} XCH</div>
        `;
        detail.appendChild(div);
      }
    }

    if (config?.phase === 2) {
      setText("claimNote", "Click Claim to sign a one-time challenge in your wallet. The Worker broadcasts the payout transaction once your signature is verified.");
    } else {
      setText("claimNote", "Phase 1 · audit only. The number above is what you'd receive in Phase 2.");
    }
  } catch (err) {
    console.error(err);
    setText("claimTotal", "error");
    setText("claimNote", err.message);
  }
}

async function loadStats(wallet) {
  const totalEl = $("totalPaid");
  const walletEl = $("walletPaid");
  if (!totalEl) return;
  try {
    const path = wallet ? `/stats?wallet=${encodeURIComponent(wallet)}` : "/stats";
    const res = await api(path);
    totalEl.textContent = fmtXch(res.totalPaidMojo ?? 0n);
    if (walletEl) {
      walletEl.textContent = res.walletPaidMojo == null ? "—" : fmtXch(res.walletPaidMojo);
    }
  } catch (err) {
    console.warn("loadStats failed:", err.message);
  }
}

async function onClaimClick() {
  if (!walletAddr) { alert("Connect your wallet first via the button at the top right."); return; }
  if (config?.phase !== 2) { alert("Phase 1 — audit only. Claim button is disabled until Phase 2 ships."); return; }
  const info = getAddressInfo();
  if (!info) { alert("No active wallet session. Connect via the button at the top right."); return; }

  const btn = $("claimBtn");
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Authorizing…";

  try {
    // 1. Get a fresh challenge from the Worker.
    const challenge = await api(`/claim/challenge?wallet=${encodeURIComponent(walletAddr)}`);

    // 2. Sign the challenge in the user's wallet.
    btn.textContent = "Sign in your wallet…";
    const sigResult = await requestRpc("chia_signMessageByAddress", {
      address: walletAddr,
      message: challenge.message,
    });

    const pubkey = sigResult?.publicKey ?? sigResult?.pubkey ?? sigResult?.public_key;
    const signature = sigResult?.signature ?? sigResult?.sig;
    if (!pubkey || !signature) {
      throw new Error(`Wallet returned unexpected sign payload: ${JSON.stringify(sigResult)}`);
    }

    // 3. Submit the signed claim.
    btn.textContent = "Submitting…";
    const res = await fetch(`${API_BASE}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        wallet: walletAddr,
        message: challenge.message,
        nonce: challenge.nonce,
        pubkey: stripHexPrefix(pubkey),
        signature: stripHexPrefix(signature),
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      let parsed; try { parsed = JSON.parse(text); } catch {}
      throw new Error(parsed?.error ?? text);
    }
    const out = JSON.parse(text, reviveBigInts);

    if (out.broadcast) {
      setText("claimNote", `Paid ${fmtXch(out.totalOwedMojo ?? 0n)} XCH. tx: ${out.txId ?? "(unknown)"}`);
      btn.textContent = "Claimed ✓";
      loadStats(walletAddr).catch(() => {});
      // Refresh the claim panel after a delay so the new state shows.
      setTimeout(() => loadClaim(walletAddr).catch(() => {}), 5000);
    } else {
      setText("claimNote", `Verified — would have paid ${fmtXch(out.totalOwedMojo ?? 0n)} XCH. Live broadcast pending.`);
      btn.textContent = "Verified ✓";
    }
  } catch (err) {
    console.error("Claim failed:", err);
    alert(`Claim failed: ${err.message}`);
    btn.textContent = orig;
    btn.disabled = config?.phase !== 2;
  }
}

// ---------- go ----------

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
