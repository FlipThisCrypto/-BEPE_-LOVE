// Records that a token was successfully minted via the wallet.
// The frontend POSTs here after chia_takeOffer returns success.
//
// Endpoint: POST /api/mint/confirm
// Body:    { tokenNumber: number, walletFingerprint?: string }
// Returns: { ok: true, totalConfirmed: number, alreadyConfirmed: bool }
//
// Idempotent: re-confirming the same token is a no-op. Race-safe via
// Blobs ETag-based optimistic concurrency.

import { getStore } from "@netlify/blobs";

const CONFIRMED_KEY = "confirmed-set";
const MAX_RETRIES = 5;

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "invalid_body" }, 400); }

  const tokenNum = Number(body?.tokenNumber);
  if (!Number.isInteger(tokenNum) || tokenNum < 1 || tokenNum > 2222) {
    return json({ error: "invalid_tokenNumber" }, 400);
  }

  const fp = typeof body.walletFingerprint === "string" ? body.walletFingerprint.slice(0, 32) : null;
  const queue = getStore("bepe-mint-queue");
  const offers = getStore("bepe-mint-offers");

  // Optional claim-token validation. If the frontend forwards a claimToken
  // (set by /api/mint/random when dispensing), we validate and consume it.
  // Cached frontends without claim-token still work — we'll harden later via
  // wallet-signature auth without breaking any in-flight flows.
  const claimToken = typeof body?.claimToken === "string" ? body.claimToken : null;
  if (claimToken) {
    const claim = await queue.get(`claims/${claimToken}`, { type: "json" });
    if (claim && claim.tokenNumber === tokenNum) {
      // Valid claim — consume it (one-shot, prevents replay).
      await queue.delete(`claims/${claimToken}`).catch(() => {});
    }
    // If the claim doesn't validate, fall through anyway (backwards-compat).
    // This is intentional for v1 to avoid breaking cached frontends mid-mint.
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let current;
    let etag;
    const result = await queue.getWithMetadata(CONFIRMED_KEY, { type: "json", consistency: "strong" });
    if (result) {
      current = result.data;
      etag = result.etag;
    } else {
      current = { tokens: [], entries: [] };
      etag = null;
    }

    if (current.tokens.includes(tokenNum)) {
      return json({ ok: true, alreadyConfirmed: true, totalConfirmed: current.tokens.length });
    }

    const next = {
      tokens: [...current.tokens, tokenNum],
      entries: [...(current.entries || []), { tokenNumber: tokenNum, fp, ts: Date.now() }],
    };
    if (next.entries.length > 5000) next.entries = next.entries.slice(-5000);

    try {
      await queue.setJSON(CONFIRMED_KEY, next, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });

      // Clear this wallet's reservation now that the mint is confirmed.
      // Without this, the user would be locked to the same token for the
      // full TTL window even though they've already minted it.
      clearReservation(queue, tokenNum, fp).catch(err => console.warn("reservation clear failed:", err));

      // Advance the queue counter past any newly-confirmed prefix. This is
      // an optimization so the dispenser's scan starts at the next live
      // index. Best-effort — incorrect values just slow the scan slightly.
      advanceCounter(queue, next.tokens).catch(err => console.warn("counter advance failed:", err));

      // Best-effort cleanup: delete the offer blob now that it's been minted.
      const offerKey = `offer/${String(tokenNum).padStart(4, "0")}`;
      offers.delete(offerKey).catch(err => console.warn(`offer cleanup failed for ${offerKey}:`, err));

      return json({ ok: true, alreadyConfirmed: false, totalConfirmed: next.tokens.length });
    } catch (err) {
      // Conflict — retry with fresh read.
      if (attempt === MAX_RETRIES - 1) {
        return json({ error: "contention", detail: String(err.message || err) }, 503);
      }
    }
  }

  return json({ error: "unreachable" }, 500);
};

export const config = {
  path: "/api/mint/confirm",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// Remove the reservation that covers this confirmed token. Best-effort —
// the dispenser also sweeps expired reservations, so failure here just means
// the wallet stays locked to this (now-minted) token for the rest of its TTL.
async function clearReservation(queue, tokenNum, fp) {
  const result = await queue.getWithMetadata("reservations", { type: "json", consistency: "strong" });
  if (!result) return;
  const map = result.data ?? {};
  let mutated = false;
  // Prefer the fp match, fall back to any reservation pointing at this token
  // (covers cases where confirm came in without a fingerprint).
  for (const [k, r] of Object.entries(map)) {
    if ((fp && k === fp && r?.tokenNumber === tokenNum) ||
        (!fp && r?.tokenNumber === tokenNum)) {
      delete map[k];
      mutated = true;
    }
  }
  if (mutated) {
    try {
      await queue.setJSON("reservations", map, { onlyIfMatch: result.etag });
    } catch (_) { /* CAS conflict OK — dispenser sweeps stale entries */ }
  }
}

// Advance the queue's `counter` past any contiguous prefix of confirmed tokens.
// Just a hint for the dispenser scan — doesn't affect correctness if it's off.
async function advanceCounter(queue, confirmedTokens) {
  const confirmedSet = new Set(confirmedTokens);
  const result = await queue.getWithMetadata("queue", { type: "json", consistency: "strong" });
  if (!result) return;
  const q = result.data;
  if (!q || !Array.isArray(q.shuffled)) return;
  let c = q.counter ?? 0;
  while (c < q.shuffled.length && confirmedSet.has(q.shuffled[c])) c++;
  if (c !== q.counter) {
    try {
      await queue.setJSON("queue", { ...q, counter: c }, { onlyIfMatch: result.etag });
    } catch (_) { /* CAS conflict OK */ }
  }
}
