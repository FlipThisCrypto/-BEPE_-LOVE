// Records that a user APPEARED to mint via their wallet — but does NOT
// trust the wallet's claim on its own. Adds the token to a "pending-set"
// instead of the confirmed-set. The periodic reconcile function (or the
// admin audit-on-chain action) verifies against Mintgarden's on-chain
// data and promotes pending → confirmed only when the chain agrees.
//
// This closes the "Sage returned success but chain rejected" exploit
// vector where a malicious user could approve in Sage's WC layer without
// the spend actually broadcasting, pumping the counter without minting.
//
// Endpoint: POST /api/mint/confirm
// Body:    { tokenNumber, claimToken, walletFingerprint? }
// Returns: { ok: true, pending: true } on first record
//          { ok: true, alreadyPending: true } on repeat
//          { ok: true, alreadyConfirmed: true } if already on-chain confirmed

import { getStore } from "@netlify/blobs";

const PENDING_KEY = "pending-set";
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

  // Validate claim token (gates against random POST attacks).
  const claimToken = typeof body?.claimToken === "string" ? body.claimToken : null;
  if (claimToken) {
    const claim = await queue.get(`claims/${claimToken}`, { type: "json" });
    if (claim && claim.tokenNumber === tokenNum) {
      await queue.delete(`claims/${claimToken}`).catch(() => {});
    }
    // Fall through if claim missing — backwards-compat with old clients.
  }

  // Already confirmed on-chain? No-op.
  const confirmedRaw = await queue.get(CONFIRMED_KEY, { type: "json" });
  const confirmedSet = new Set(confirmedRaw?.tokens ?? []);
  if (confirmedSet.has(tokenNum)) {
    return json({ ok: true, alreadyConfirmed: true, totalConfirmed: confirmedSet.size });
  }

  // Add to pending-set with CAS.
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const pendingResult = await queue.getWithMetadata(PENDING_KEY, { type: "json", consistency: "strong" });
    const current = pendingResult?.data ?? { entries: [] };
    const etag = pendingResult?.etag;

    // Already in pending? No-op.
    if (current.entries.some(e => e.tokenNumber === tokenNum)) {
      // Clear reservation anyway (in case the user is retrying after a transient error).
      clearReservation(queue, tokenNum, fp).catch(() => {});
      return json({ ok: true, alreadyPending: true, totalPending: current.entries.length });
    }

    const newEntries = [
      ...current.entries,
      { tokenNumber: tokenNum, fp, ts: Date.now(), source: "mint-confirm" },
    ];
    if (newEntries.length > 5000) newEntries.splice(0, newEntries.length - 5000);

    try {
      const opts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
      await queue.setJSON(PENDING_KEY, { entries: newEntries }, opts);

      // Clear the user's reservation now that we have a record of their attempt.
      // If the reconciler later finds the mint never happened, the token goes back
      // to the dispenser pool (pending-set entry gets dropped).
      clearReservation(queue, tokenNum, fp).catch(err => console.warn("res clear:", err));

      // DELIBERATELY DO NOT delete the offer blob here — we don't yet know if the
      // mint actually went through. The reconciler deletes the offer once
      // confirmed on-chain.

      return json({
        ok: true,
        pending: true,
        totalPending: newEntries.length,
        note: "Mint recorded as pending. Will be confirmed once on-chain verification completes.",
      });
    } catch (err) {
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

async function clearReservation(queue, tokenNum, fp) {
  const result = await queue.getWithMetadata("reservations", { type: "json", consistency: "strong" });
  if (!result) return;
  const map = result.data ?? {};
  let mutated = false;
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
    } catch (_) { /* CAS conflict OK */ }
  }
}
