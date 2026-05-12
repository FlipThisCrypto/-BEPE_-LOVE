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
  //
  // ANTI-EXPLOIT NOTE: deliberately do NOT reveal the token number here.
  // Showing it pre-approval let users reject undesired draws and click again
  // to cycle for rarities. Sage still shows the NFT name in its own approval
  // screen — but the dispenser now reserves the token per-wallet so
  // rejecting and re-clicking just returns the same token for the TTL window.
  if (status) {
    status.className = "mint-status info";
    status.textContent = offerData.reserved
      ? "Resuming your reserved Bepe — approve in your wallet…"
      : "Offer ready — approve the mint in your Chia wallet…";
  }
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
    // The claimToken from /api/mint/random proves this confirm is tied to a
    // real dispense, so the endpoint can't be spammed by random POSTs.
    fetch(CONFIRM_API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tokenNumber: offerData.tokenNumber,
        claimToken: offerData.claimToken,
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
  // Strict success detection. Only fire /api/mint/confirm (which clears the
  // wallet's reservation) when we have POSITIVE evidence that Sage actually
  // broadcast the take. Anything ambiguous → treat as a non-success so the
  // reservation persists for the full TTL.
  //
  // Sage's successful takeOffer returns an object with at least one of:
  //   tradeId / trade_id / tradeRecord / trade_record / spendBundle /
  //   spend_bundle / success: true
  // Any of those = real take broadcast. Without any of them, the wallet
  // either rejected, errored out, or returned a non-broadcasting
  // acknowledgement — none of which should advance the mint state.
  try {
    const result = await requestRpc("chia_takeOffer", {
      offer: offerText,
      fee: 0,
    });

    if (!result || typeof result !== "object") {
      return { ok: false, reason: "Wallet returned empty response" };
    }
    if (result.success === false) {
      return { ok: false, reason: result.error || "Wallet rejected the offer" };
    }
    if (result.error || result.rejected) {
      return { ok: false, reason: result.error || "Wallet rejected" };
    }

    const hasPositiveSuccessMarker =
      result.success === true ||
      result.tradeId ||
      result.trade_id ||
      result.tradeRecord ||
      result.trade_record ||
      result.spendBundle ||
      result.spend_bundle;

    if (!hasPositiveSuccessMarker) {
      console.warn("takeOffer returned ambiguous response (treating as not-yet-successful):", result);
      return { ok: false, reason: "Wallet response was unclear — your reservation stays active for 10 minutes. Click Mint again to retry." };
    }

    return { ok: true, raw: result };
  } catch (err) {
    const msg = err.message || String(err);
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
    // Reveal image + trait NAMES (helps the user know what they're holding)
    // but NOT rarity or points — those stay hidden until the mint actually
    // confirms on-chain. This is part of the anti-gaming layer: a holder
    // can't easily decide "skip and retry" based on tier rarity.
    const nft = res.tokenNumber ? manifest.find(n => n.id === res.tokenNumber) : null;

    panel.innerHTML = `
      <div class="mint-result-card fallback">
        <div class="mint-result-head">
          <span class="mr-emoji">🔒</span>
          <h3>Your Bepe is reserved</h3>
        </div>

        <p><b>No XCH has been spent</b> — your wallet rejected the auto-mint request before any transaction. The offer is still claimable; just click <b>Mint a Random Bepe</b> again to retry. This Bepe is locked to your wallet for the next 10 minutes — no one else can grab it during that window.</p>

        ${nft ? `
          <div class="mint-result-body" style="margin-top: 16px;">
            <img src="${nft.card}" alt="Your reserved Bepe" />
            <div class="mint-result-info" style="font-size: 13px;">
              <p style="margin: 0 0 8px; color: var(--ink); font-weight: 700;">This Bepe wears:</p>
              <ul style="margin: 0; padding: 0; list-style: none; line-height: 1.7;">
                <li>🎨 ${escapeHtml(nft.traits.background)}</li>
                <li>🙂 ${escapeHtml(nft.traits.face)}</li>
                <li>👀 ${escapeHtml(nft.traits.eyes)}</li>
                <li>👄 ${escapeHtml(nft.traits.mouth)}</li>
                <li>🧥 ${escapeHtml(nft.traits.jacket)}</li>
                <li>🏷 ${escapeHtml(nft.traits.patch)}</li>
                <li>✨ ${escapeHtml(nft.traits.accessory)}</li>
              </ul>
            </div>
          </div>
        ` : ""}

        ${isPermErr ? `
          <p style="margin-top: 16px; color: var(--ink-2); font-size: 13px;">
            <b>Tip:</b> if your wallet keeps rejecting, click the wallet button (top right) → <b>Disconnect</b> → <b>Connect Wallet</b> → approve the permissions again, then click Mint.
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
