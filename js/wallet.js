// Chia WalletConnect integration — vanilla JS, no build step.
// Uses @walletconnect/sign-client v2 via esm.sh.
//
// Public API:
//   init()                     — restore any existing session, returns address-info or null
//   connect()                  — open QR modal, wait for wallet approval, returns address-info
//   disconnect()               — end session
//   getAddressInfo()           — { fingerprint, chain } if connected, else null
//   getCurrentBech32Address()  — async, RPC call returning the wallet's xch1... address
//   onChange(fn)               — subscribe to connect/disconnect events; returns unsubscribe

import SignClient from "https://esm.sh/@walletconnect/sign-client@2.13.0";
import QRCode from "https://esm.sh/qrcode@1.5.4";

const PROJECT_ID = "04650e37bf0643ffe10266d3d9e413b8";
const DEFAULT_CHAIN = "chia:mainnet";

const METADATA = {
  name: "Bepe Love",
  description: "2,222 wizard-coded NFTs on Chia. Card auto-battler + kid match game built in.",
  url: typeof location !== "undefined" ? location.origin : "https://bepelove.com",
  icons: [
    typeof location !== "undefined" ? `${location.origin}/favicon.svg` : "",
  ],
};

let client = null;
let session = null;
const listeners = new Set();

async function getClient() {
  if (client) return client;
  client = await SignClient.init({
    projectId: PROJECT_ID,
    metadata: METADATA,
  });
  client.on("session_delete", () => { session = null; notify(); });
  client.on("session_expire", () => { session = null; notify(); });
  client.on("session_update", () => { /* no-op for now */ });

  const all = client.session.getAll();
  if (all.length) session = all[all.length - 1];
  return client;
}

export async function init() {
  try {
    await getClient();
    notify();
    return getAddressInfo();
  } catch (err) {
    console.warn("Wallet init failed:", err);
    return null;
  }
}

export function getAddressInfo() {
  if (!session) return null;
  const accounts = session.namespaces?.chia?.accounts ?? [];
  if (!accounts.length) return null;
  // Format: "chia:mainnet:<fingerprint>"
  const [chainNs, chainName, fingerprint] = accounts[0].split(":");
  return {
    fingerprint,
    chain: `${chainNs}:${chainName}`,
    accountString: accounts[0],
  };
}

export async function getCurrentBech32Address(walletId = 1) {
  if (!session) return null;
  const c = await getClient();
  const info = getAddressInfo();
  if (!info) return null;
  try {
    const result = await c.request({
      topic: session.topic,
      chainId: info.chain,
      request: {
        method: "chia_getCurrentAddress",
        params: { fingerprint: Number(info.fingerprint), walletId },
      },
    });
    // Different wallets return slightly different shapes — normalize.
    if (typeof result === "string") return result;
    return result?.address ?? result?.data ?? null;
  } catch (err) {
    console.warn("getCurrentAddress failed:", err);
    return null;
  }
}

export async function connect() {
  const c = await getClient();
  const { uri, approval } = await c.connect({
    requiredNamespaces: {
      chia: {
        methods: ["chia_logIn"],
        chains: [DEFAULT_CHAIN],
        events: [],
      },
    },
    optionalNamespaces: {
      chia: {
        methods: [
          "chia_getCurrentAddress",
          "chia_getNextAddress",
          "chia_getWallets",
          "chia_getWalletBalance",
          "chia_takeOffer",
          "chia_signMessageByAddress",
        ],
        chains: [DEFAULT_CHAIN],
        events: [],
      },
    },
  });
  if (!uri) throw new Error("WalletConnect did not return a pairing URI");

  showQrModal(uri);
  try {
    session = await approval();
    notify();
    return getAddressInfo();
  } finally {
    hideQrModal();
  }
}

export async function disconnect() {
  if (!session) return;
  const c = await getClient();
  try {
    await c.disconnect({
      topic: session.topic,
      reason: { code: 6000, message: "User disconnected" },
    });
  } catch (err) {
    console.warn("Disconnect error:", err);
  }
  session = null;
  notify();
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  const info = getAddressInfo();
  for (const fn of listeners) {
    try { fn(info); } catch (e) { console.error(e); }
  }
}

// ---------- QR modal ----------

let modalEl = null;

async function showQrModal(uri) {
  hideQrModal();
  modalEl = document.createElement("div");
  modalEl.className = "wc-modal";
  modalEl.innerHTML = `
    <div class="wc-modal-shell">
      <button class="wc-modal-close" aria-label="Close">×</button>
      <h3 class="wc-modal-title">Connect Chia Wallet</h3>
      <p class="wc-modal-sub">
        Open your Chia wallet → <b>WalletConnect</b> → <b>Add Connection</b>,
        then scan this QR code or paste the link below.
      </p>
      <div class="wc-qr" id="wcQr"></div>
      <div class="wc-uri-row">
        <input type="text" id="wcUri" readonly value="${escapeAttr(uri)}" />
        <button class="btn ghost" id="wcCopy">Copy</button>
      </div>
      <p class="wc-modal-hint">
        Connecting from your phone? <a href="${escapeAttr(uri)}" id="wcDeepLink">Open in wallet app →</a>
      </p>
    </div>
  `;
  document.body.appendChild(modalEl);
  document.body.style.overflow = "hidden";

  // Render QR
  try {
    const dataUrl = await QRCode.toDataURL(uri, { width: 280, margin: 1, color: { dark: "#06040f", light: "#ffffff" } });
    const img = document.createElement("img");
    img.src = dataUrl;
    img.alt = "WalletConnect QR";
    modalEl.querySelector("#wcQr").appendChild(img);
  } catch (err) {
    console.error("QR generation failed:", err);
    modalEl.querySelector("#wcQr").textContent = "(QR unavailable — copy link below)";
  }

  modalEl.querySelector(".wc-modal-close").addEventListener("click", cancelConnect);
  modalEl.addEventListener("click", (e) => { if (e.target === modalEl) cancelConnect(); });
  modalEl.querySelector("#wcCopy").addEventListener("click", () => {
    const inp = modalEl.querySelector("#wcUri");
    inp.select();
    try { document.execCommand("copy"); } catch (_) {}
    const btn = modalEl.querySelector("#wcCopy");
    const prev = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = prev; }, 1200);
  });
}

function hideQrModal() {
  if (modalEl) modalEl.remove();
  modalEl = null;
  document.body.style.overflow = "";
}

function cancelConnect() {
  hideQrModal();
  // Note: we don't actively reject the approval Promise here — sign-client will time out
  // its own pairing. Closing the modal is enough UX-wise.
}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
