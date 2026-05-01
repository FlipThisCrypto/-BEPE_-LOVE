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
    // Wallets that don't support chia_takeOffer (e.g., the Chia reference
    // wallet) reject with "Invalid Request". The offer is still valid — fall
    // back to a manual file download so the user can import it into their
    // wallet themselves. NO XCH has been spent at this point; takeOffer
    // failed before any transaction was sent.
    showResult({
      kind: "wallet-error",
      tokenNumber: offerData.tokenNumber,
      offerText: offerData.offerText,
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
    const isUnsupported = /Invalid Request|UNSUPPORTED_METHODS|method not found/i.test(res.reason || "");

    // Always offer the offer-file download — no XCH has been spent yet, and
    // every Chia wallet can import an offer file manually. This is the
    // safety net for anyone not on Sage.
    const blob = res.offerText ? new Blob([res.offerText], { type: "text/plain" }) : null;
    const downloadUrl = blob ? URL.createObjectURL(blob) : null;

    panel.innerHTML = `
      <div class="mint-result-card fallback">
        <div class="mint-result-head">
          <span class="mr-emoji">📥</span>
          <h3>Mint Bepe Love #${pad(res.tokenNumber)} manually</h3>
        </div>

        <p><b>No XCH has been spent</b> — your wallet rejected the auto-mint request before any transaction. The offer for #${pad(res.tokenNumber)} is still claimable; you just need to import it manually.</p>

        <p style="margin: 14px 0 6px;"><b>Why this happened:</b> ${
          isPermErr
            ? "your wallet session was paired before <code>chia_takeOffer</code> was a required permission. Disconnect and reconnect once and the next mint should be one-click."
            : isUnsupported
              ? "your wallet doesn't support <code>chia_takeOffer</code> over WalletConnect yet. <b>Sage Wallet</b> is the recommended wallet for one-click mint. Other wallets need the manual import below."
              : `the wallet returned <code>${escapeHtml(res.reason || "unknown reason")}</code>.`
        }</p>

        ${downloadUrl ? `
          <p style="margin-top: 18px;">
            <a class="btn primary" href="${downloadUrl}" download="bepe_love_${pad(res.tokenNumber)}.offer">⬇ Download offer file</a>
          </p>
          <ol class="mint-instructions">
            <li>Open your Chia wallet.</li>
            <li>Go to <b>Offers</b> → <b>View an Offer</b> (or <b>Take an Offer</b>).</li>
            <li>Drag the downloaded file in (or paste its contents).</li>
            <li>Confirm the <b>2 XCH</b> payment and accept.</li>
            <li>Bepe Love #${pad(res.tokenNumber)} arrives in ~30 seconds.</li>
          </ol>
        ` : ""}

        ${isPermErr ? `
          <p style="margin-top: 14px; color: var(--ink-2); font-size: 13px;">
            <b>Or skip the manual step:</b> click the wallet button (top right) → <b>Disconnect</b> → <b>Connect Wallet</b> → approve the new permissions in your wallet, then click Mint again.
          </p>
        ` : ""}
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
