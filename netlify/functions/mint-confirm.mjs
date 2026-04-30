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

      // Best-effort cleanup: delete the offer blob now that it's been minted.
      // The queue counter is already past this token so it can't be re-dispensed
      // either way — this is just storage tidying. Failure here doesn't fail
      // the confirm response.
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
