// Random Mint dispenser — reservation-based.
//
// Endpoint: POST /api/mint/random
// Body:    { walletFingerprint: string, walletAddr?: string }  (fp required)
// Returns: { tokenNumber, offerText, claimToken, reserved: bool }
//          or { error: "sold_out" }
//
// Anti-exploit design notes:
//   The previous implementation advanced the queue counter on every dispense.
//   That let a user click Mint -> see what they got -> reject -> click Mint
//   again to "shuffle" through tokens until they hit a rare one, burning queue
//   slots along the way. By the end of the run the public counter had outpaced
//   reality by ~1500 burned slots.
//
//   The new design RESERVES tokens per wallet for a TTL window. While a user
//   has an active reservation, every subsequent /api/mint/random call from
//   that wallet returns the SAME token + same claim token. The user has one
//   draw at a time — they can't cycle. After the TTL expires (10 min), the
//   token returns to the pool. The queue counter only advances when a mint
//   actually confirms on-chain.
//
// State stores:
//   bepe-mint-offers  — key "offer/<NNNN>"      -> raw offer text
//   bepe-mint-queue   — key "queue"             -> { shuffled, counter, total }
//                       key "confirmed-set"     -> { tokens, entries }
//                       key "reservations"      -> { [fp]: { tokenNumber, ts, claimToken } }
//                       key "claims/<token>"    -> { tokenNumber, ts, fp }
//                       key "dispensed"         -> { items: [...] }

import { getStore } from "@netlify/blobs";

const RES_TTL_MS = 10 * 60 * 1000;   // 10 minutes per reservation
const MAX_CAS_RETRIES = 5;

export default async (req) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405);
  }

  let body = {};
  try {
    if (req.method === "POST") {
      const text = await req.text();
      body = text ? JSON.parse(text) : {};
    }
  } catch (_) { body = {}; }

  // Wallet fingerprint required for reservation tracking.
  const fp = typeof body.walletFingerprint === "string" ? body.walletFingerprint.slice(0, 32) : null;
  if (!fp) {
    return json({
      error: "wallet_required",
      message: "Connect a Chia wallet first — required for the new per-wallet reservation system.",
    }, 400);
  }

  const offers = getStore("bepe-mint-offers");
  const queue = getStore("bepe-mint-queue");
  const now = Date.now();

  // Read confirmed-set (on-chain verified) AND pending-set (claimed by
  // wallet, awaiting on-chain verification). Skip both during dispense.
  // Without skipping pending, two users could claim the same token and
  // race the chain — only one wins, the other wallet shows an error.
  const confirmed = await queue.get("confirmed-set", { type: "json" });
  const confirmedSet = new Set(confirmed?.tokens ?? []);
  const pending = await queue.get("pending-set", { type: "json" });
  const pendingSet = new Set((pending?.entries ?? []).map(e => e.tokenNumber));

  // Read queue (used for the shuffled list + counter as a scan hint)
  const q = await queue.get("queue", { type: "json" });
  if (!q || !Array.isArray(q.shuffled)) {
    return json({ error: "not_initialized", message: "Mint queue has not been bootstrapped." }, 503);
  }

  // CAS loop on the reservations blob — handles concurrent dispense attempts
  // from multiple wallets without double-issuing a token.
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const resResult = await queue.getWithMetadata("reservations", { type: "json", consistency: "strong" });
    const reservations = resResult?.data ?? {};
    const resEtag = resResult?.etag;

    // Sweep expired entries.
    for (const [k, r] of Object.entries(reservations)) {
      if (now - (r?.ts ?? 0) > RES_TTL_MS) {
        delete reservations[k];
        // Best-effort claim cleanup
        if (r?.claimToken) {
          queue.delete(`claims/${r.claimToken}`).catch(() => {});
        }
      }
    }

    // If this wallet already has an active reservation, return the SAME token.
    // This is the anti-cycling defense — rejecting and re-clicking yields the
    // same draw, not a new random one.
    if (reservations[fp]) {
      const existing = reservations[fp];
      let offerText = null;
      try {
        offerText = await offers.get(`offer/${pad(existing.tokenNumber)}`);
      } catch (_) {}
      if (offerText && offerText.startsWith("offer1")) {
        return json({
          tokenNumber: existing.tokenNumber,
          offerText,
          claimToken: existing.claimToken,
          reserved: true,
          reservedAtMs: existing.ts,
          expiresAtMs: existing.ts + RES_TTL_MS,
        });
      }
      // Offer text missing — bad reservation, clear and proceed to find a fresh one.
      delete reservations[fp];
    }

    // Build the "currently reserved" token set (after expiry sweep).
    const reservedTokens = new Set();
    for (const r of Object.values(reservations)) {
      if (r?.tokenNumber != null) reservedTokens.add(r.tokenNumber);
    }

    // Find the next available token by scanning the shuffled list from the
    // counter forward (counter is a hint — the earliest index that might
    // still be available). Skip tokens that are confirmed on-chain or
    // currently reserved by someone else.
    let tokenNum = null;
    let offerText = null;
    const skipped = [];
    const start = Math.min(q.counter ?? 0, q.shuffled.length);
    for (let i = start; i < q.shuffled.length; i++) {
      const candidate = q.shuffled[i];
      if (confirmedSet.has(candidate)) continue;
      if (pendingSet.has(candidate)) continue;
      if (reservedTokens.has(candidate)) continue;
      // Verify the offer exists in storage (defends against partial bootstraps).
      let t = null;
      try { t = await offers.get(`offer/${pad(candidate)}`); } catch (_) {}
      if (!t || !t.startsWith("offer1")) {
        skipped.push(candidate);
        if (skipped.length > 50) {
          return json({ error: "too_many_missing_offers", skipped: skipped.slice(0, 20) }, 500);
        }
        continue;
      }
      tokenNum = candidate;
      offerText = t;
      break;
    }

    if (tokenNum == null) {
      return json({ error: "sold_out", remaining: 0 }, 410);
    }

    // Create reservation + claim token.
    const claimToken = randomToken();
    reservations[fp] = { tokenNumber: tokenNum, ts: now, claimToken };

    // Atomic CAS write of the reservations blob.
    try {
      if (resEtag) {
        await queue.setJSON("reservations", reservations, { onlyIfMatch: resEtag });
      } else {
        await queue.setJSON("reservations", reservations, { onlyIfNew: true });
      }
    } catch (err) {
      // CAS conflict — someone else updated reservations. Retry.
      if (attempt === MAX_CAS_RETRIES - 1) {
        return json({ error: "reservation_contention", detail: String(err?.message || err) }, 503);
      }
      continue;
    }

    // Store the claim token (also used to authenticate the confirm POST).
    await queue.setJSON(`claims/${claimToken}`, {
      tokenNumber: tokenNum,
      ts: now,
      fp,
    }).catch(err => console.warn("claim store failed:", err));

    // Audit log (best-effort).
    try {
      const dispensedEntry = {
        tokenNumber: tokenNum,
        ts: now,
        fp,
        addr: typeof body.walletAddr === "string" ? body.walletAddr.slice(0, 80) : null,
        reserved: true,
      };
      const log = (await queue.get("dispensed", { type: "json" })) || { items: [] };
      log.items.push(dispensedEntry);
      if (log.items.length > 5000) log.items = log.items.slice(-5000);
      await queue.setJSON("dispensed", log);
    } catch (_) {}

    return json({
      tokenNumber: tokenNum,
      offerText,
      claimToken,
      reserved: false,
      reservedAtMs: now,
      expiresAtMs: now + RES_TTL_MS,
    });
  }

  return json({ error: "reservation_contention" }, 503);
};

export const config = {
  path: "/api/mint/random",
};

function randomToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(36).padStart(2, "0")).join("").slice(0, 22);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function pad(n) { return String(n).padStart(4, "0"); }
