// Random Mint frontend flow.
//
// Click "Mint a Random Bepe" -> POST /api/mint/random -> receive { tokenNumber, offerText }.
// Try chia_takeOffer via WalletConnect first; fall back to .offer file download
// with clear instructions.

import { loadManifest, tierClass, elementClass } from "./data.js";
import { getAddressInfo, getCurrentBech32Address, connect, requestRpc } from "./wallet.js";

const MINT_API = "/api/mint/random";
const STATUS_API = "/api/mint/status";
const CONFIRM_API = "/api/mint/confirm";

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

  // 3. Push the offer into the wallet via WalletConnect — only path. If this
  // fails (e.g., the wallet hasn't approved chia_takeOffer at pairing time),
  // tell the user how to fix it (disconnect + reconnect).
  if (status) { status.className = "mint-status info"; status.textContent = `Got Bepe Love #${pad(offerData.tokenNumber)} — approve in your wallet…`; }
  let takeResult;
  try {
    takeResult = await takeOfferViaWallet(offerData.offerText);
  } catch (err) {
    console.warn("takeOffer failed:", err);
    takeResult = { ok: false, reason: String(err.message || err) };
  }

  if (takeResult.ok) {
    // Tell the server this mint actually went through so the public counter
    // reflects reality. Best-effort — failures here don't block the user.
    fetch(CONFIRM_API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tokenNumber: offerData.tokenNumber,
        walletFingerprint: info.fingerprint,
      }),
    }).catch(err => console.warn("mint-confirm POST failed:", err));
    showResult({ kind: "success", tokenNumber: offerData.tokenNumber });
  } else {
    showResult({
      kind: "wallet-error",
      tokenNumber: offerData.tokenNumber,
      reason: takeResult.reason,
    });
  }

  refreshStatus().catch(() => {});
  btn.disabled = false;
  btn.textContent = origText;
}

async function takeOfferViaWallet(offerText) {
  // Uses the shared sign-client session from wallet.js so the namespaces
  // approved at pairing time apply.
  try {
    const result = await requestRpc("chia_takeOffer", {
      offer: offerText,
      fee: 0,
    });
    if (result?.success === false) {
      return { ok: false, reason: result.error || "Wallet rejected the offer" };
    }
    return { ok: true, raw: result };
  } catch (err) {
    const msg = err.message || String(err);
    // Surface a clearer message when the method wasn't approved at pairing.
    if (/Missing or invalid|not approved/i.test(msg)) {
      return { ok: false, reason: "Wallet didn't approve chia_takeOffer at pairing — disconnect and reconnect to grant the new permission." };
    }
    return { ok: false, reason: msg };
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
  } else if (res.kind === "wallet-error") {
    const isPermErr = /Missing or invalid|not approved|disapproved|disconnect and reconnect/i.test(res.reason || "");
    panel.innerHTML = `
      <div class="mint-result-card error">
        <div class="mint-result-head">
          <span class="mr-emoji">${isPermErr ? "🔐" : "⚠️"}</span>
          <h3>${isPermErr ? "Wallet permissions need a refresh" : "Wallet didn't accept the offer"}</h3>
        </div>
        ${isPermErr ? `
          <p>Your wallet was paired before <b>chia_takeOffer</b> was added to the required permissions.
          Disconnect and reconnect once to grant the new permission, then click Mint again.</p>
          <ol class="mint-instructions">
            <li>Click the green <b>wallet button</b> at the top right.</li>
            <li>Confirm <b>Disconnect</b>.</li>
            <li>Click <b>Connect Wallet</b> again and approve the new pairing in your Chia wallet.</li>
            <li>Click <b>Mint a Random Bepe</b> again — the spend prompt will pop up in your wallet.</li>
          </ol>
        ` : `
          <p>The wallet returned: <code>${escapeHtml(res.reason || "unknown reason")}</code></p>
          <p>This Bepe (#${pad(res.tokenNumber)}) is now reserved as dispensed. Try clicking Mint again to draw a fresh one.</p>
        `}
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
