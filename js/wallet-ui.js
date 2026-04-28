// Wallet button + status pill, shared across index/play/match.
//
// Mounts itself into the header nav, listens to wallet.onChange, and updates
// score-store's active wallet so all leaderboards are wallet-namespaced
// the moment a session is established.

import { init, connect, disconnect, getAddressInfo, onChange, getCurrentBech32Address } from "./wallet.js";
import { setActiveWallet } from "./score-store.js";

const BTN_ID = "walletBtn";

let cachedBech32 = null;

function shortAddr(s, head = 6, tail = 4) {
  if (!s) return "";
  return s.length <= head + tail + 3 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function render() {
  const btn = document.getElementById(BTN_ID);
  if (!btn) return;
  const info = getAddressInfo();
  if (!info) {
    btn.className = "wallet-btn";
    btn.innerHTML = `<span class="wb-dot"></span><span class="wb-label">Connect Wallet</span>`;
    btn.title = "Connect a Chia wallet via WalletConnect";
    return;
  }
  const display = cachedBech32 ? shortAddr(cachedBech32, 8, 5) : `fp ${info.fingerprint}`;
  btn.className = "wallet-btn connected";
  btn.innerHTML = `<span class="wb-dot live"></span><span class="wb-label">${display}</span><span class="wb-caret">▾</span>`;
  btn.title = `Connected · ${cachedBech32 || `fingerprint ${info.fingerprint}`}\nClick to disconnect`;
}

async function refreshBech32() {
  cachedBech32 = await getCurrentBech32Address();
  render();
}

function ensureMounted() {
  // Find the existing nav in header and append the wallet button if not present.
  if (document.getElementById(BTN_ID)) return;
  const nav = document.querySelector("header nav");
  if (!nav) return;
  const btn = document.createElement("button");
  btn.id = BTN_ID;
  btn.className = "wallet-btn";
  btn.type = "button";
  btn.innerHTML = `<span class="wb-dot"></span><span class="wb-label">Connect Wallet</span>`;
  btn.addEventListener("click", onClick);
  nav.appendChild(btn);
}

async function onClick() {
  const info = getAddressInfo();
  if (info) {
    if (confirm("Disconnect wallet?")) {
      await disconnect();
    }
    return;
  }
  const btn = document.getElementById(BTN_ID);
  if (btn) { btn.disabled = true; btn.querySelector(".wb-label").textContent = "Connecting…"; }
  try {
    await connect();
  } catch (err) {
    console.error("Connect failed:", err);
    alert("Wallet connection failed or was cancelled.");
  } finally {
    if (btn) btn.disabled = false;
    render();
  }
}

async function applyConnection() {
  const info = getAddressInfo();
  if (info) {
    setActiveWallet(info.fingerprint);
    refreshBech32().catch(() => {});
  } else {
    setActiveWallet(null);
    cachedBech32 = null;
  }
  render();
  // Notify the page so it can refresh its UI (e.g., re-render leaderboard).
  document.dispatchEvent(new CustomEvent("wallet:change", { detail: info }));
}

async function boot() {
  ensureMounted();
  onChange(applyConnection);
  await init();
  applyConnection();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
