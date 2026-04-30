// Random Mint frontend flow.
//
// Click "Mint a Random Bepe" -> POST /api/mint/random -> receive { tokenNumber, offerText }.
// Try chia_takeOffer via WalletConnect first; fall back to .offer file download
// with clear instructions.

import { loadManifest, tierClass, elementClass } from "./data.js";
import { getAddressInfo, getCurrentBech32Address, connect } from "./wallet.js";
import SignClient from "https://esm.sh/@walletconnect/sign-client@2.13.0";

const MINT_API = "/api/mint/random";
const STATUS_API = "/api/mint/status";

let manifest = [];

async function refreshStatus() {
  const total = document.getElementById("mintTotal");
  const remaining = document.getElementById("mintRemaining");
  const dispensed = document.getElementById("mintDispensed");
  if (!total) return;
  try {
    const res = await fetch(STATUS_API);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const s = await res.json();
    if (!s.initialized) {
      total.textContent = "—";
      remaining.textContent = "Bootstrap pending";
      dispensed.textContent = "—";
      return;
    }
    total.textContent = s.total.toLocaleString();
    remaining.textContent = s.remaining.toLocaleString();
    dispensed.textContent = s.dispensed.toLocaleString();
  } catch (err) {
    console.warn("Mint status fetch failed:", err);
    if (remaining) remaining.textContent = "—";
  }
}

async function onMintClick() {
  const btn = document.getElementById("mintBtn");
  const status = document.getElementById("mintStatus");
  if (!btn) return;

  // 1. Wallet required.
  let info = getAddressInfo();
  if (!info) {
    if (status) status.textContent = "Connect a Chia wallet first…";
    try { await connect(); } catch (_) { return; }
    info = getAddressInfo();
    if (!info) return;
  }

  // 2. Lock UI.
  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = "Drawing your Bepe…";
  if (status) { status.className = "mint-status info"; status.textContent = "Pulling a random offer…"; }

  let offerData = null;
  try {
    const addr = await getCurrentBech32Address().catch(() => null);
    const res = await fetch(MINT_API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        walletFingerprint: info.fingerprint,
        walletAddr: addr,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `http_${res.status}` }));
      throw new Error(err.message || err.error || `HTTP ${res.status}`);
    }
    offerData = await res.json();
  } catch (err) {
    showResult({ kind: "error", message: String(err.message || err) });
    btn.disabled = false;
    btn.textContent = origText;
    return;
  }

  // 3. Try chia_takeOffer via WalletConnect.
  if (status) { status.className = "mint-status info"; status.textContent = `Got Bepe Love #${pad(offerData.tokenNumber)} — sending to your wallet…`; }
  let takeResult;
  try {
    takeResult = await takeOfferViaWallet(offerData.offerText, info);
  } catch (err) {
    console.warn("takeOffer failed:", err);
    takeResult = { ok: false, reason: String(err.message || err) };
  }

  if (takeResult.ok) {
    showResult({ kind: "success", tokenNumber: offerData.tokenNumber });
  } else {
    // Fallback: hand the user a downloadable .offer file with instructions.
    showResult({
      kind: "fallback",
      tokenNumber: offerData.tokenNumber,
      offerText: offerData.offerText,
      reason: takeResult.reason,
    });
  }

  refreshStatus().catch(() => {});
  btn.disabled = false;
  btn.textContent = origText;
}

async function takeOfferViaWallet(offerText, info) {
  // Re-use the existing sign-client instance via the same project ID.
  const client = await SignClient.init({
    projectId: "04650e37bf0643ffe10266d3d9e413b8",
    metadata: {
      name: "Bepe Love",
      description: "Random mint dispenser",
      url: location.origin,
      icons: [`${location.origin}/favicon.svg`],
    },
  });
  const all = client.session.getAll();
  if (!all.length) {
    return { ok: false, reason: "No active wallet session" };
  }
  const session = all[all.length - 1];

  try {
    const result = await client.request({
      topic: session.topic,
      chainId: info.chain,
      request: {
        method: "chia_takeOffer",
        params: {
          fingerprint: Number(info.fingerprint),
          offer: offerText,
          fee: 0,
        },
      },
    });
    // Different wallets shape the success response differently.
    if (result?.success === false) {
      return { ok: false, reason: result.error || "Wallet rejected the offer" };
    }
    return { ok: true, raw: result };
  } catch (err) {
    return { ok: false, reason: err.message || String(err) };
  }
}

function showResult(res) {
  const panel = document.getElementById("mintResult");
  if (!panel) return;
  panel.style.display = "block";
  if (res.kind === "success") {
    const nft = manifest.find(n => n.id === res.tokenNumber);
    panel.innerHTML = `
      <div class="mint-result-card success">
        <div class="mint-result-head">
          <span class="mr-emoji">🎉</span>
          <h3>You minted Bepe Love #${pad(res.tokenNumber)}</h3>
        </div>
        ${nft ? `
          <div class="mint-result-body">
            <img src="${nft.card}" alt="${nft.name}" />
            <div class="mint-result-info">
              <span class="tier ${tierClass(nft.tier)}">${nft.tier}</span>
              <span class="element ${elementClass(nft.element)}">${nft.element}</span>
              <span class="points-badge">${nft.points} PTS</span>
              <p>Rank #${nft.rank} · ${nft.traits.background}</p>
            </div>
          </div>
        ` : ""}
        <p class="mint-result-foot">It'll appear in your wallet once Chia confirms the block (~30 seconds).</p>
      </div>
    `;
  } else if (res.kind === "fallback") {
    const blob = new Blob([res.offerText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    panel.innerHTML = `
      <div class="mint-result-card fallback">
        <div class="mint-result-head">
          <span class="mr-emoji">📥</span>
          <h3>Download to mint Bepe Love #${pad(res.tokenNumber)}</h3>
        </div>
        <p>Your wallet didn't accept the offer automatically (${escapeHtml(res.reason || "unknown reason")}).
        Download the offer file below and open it in your Chia wallet:</p>
        <p><a class="btn primary" href="${url}" download="bepe_love_${pad(res.tokenNumber)}.offer">⬇ Download offer</a></p>
        <ol class="mint-instructions">
          <li>Open the Chia wallet (or Goby).</li>
          <li>Go to <b>Offers</b> → <b>View an Offer</b>.</li>
          <li>Drag the downloaded file in (or paste contents). Confirm <b>2 XCH</b> payment, accept.</li>
          <li>Bepe Love #${pad(res.tokenNumber)} arrives within ~30 seconds.</li>
        </ol>
      </div>
    `;
  } else {
    panel.innerHTML = `
      <div class="mint-result-card error">
        <div class="mint-result-head">
          <span class="mr-emoji">⚠️</span>
          <h3>Mint couldn't start</h3>
        </div>
        <p>${escapeHtml(res.message || "Unknown error.")}</p>
        <p>Try again in a moment, or check the Discord for status.</p>
      </div>
    `;
  }
}

function pad(n) { return String(n).padStart(4, "0"); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function init() {
  try {
    manifest = await loadManifest();
  } catch (_) {}
  document.getElementById("mintBtn")?.addEventListener("click", onMintClick);
  refreshStatus();
  setInterval(refreshStatus, 30_000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
