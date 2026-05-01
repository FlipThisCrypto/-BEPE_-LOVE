// Random Mint dispenser — reads the shuffled queue, atomically pops the next
// token number, fetches that offer, returns to client.
//
// Endpoint: POST /api/mint/random
// Body:    { walletFingerprint?: string, walletAddr?: string }  (optional, for audit)
// Returns: { tokenNumber: number, offerText: string, remaining: number }
//          or { error: "sold_out" } when the queue is empty
//
// State stores:
//   bepe-mint-offers  — key "offer/<NNNN>"  -> raw offer text
//   bepe-mint-queue   — key "queue"         -> { shuffled: [N...], counter: N, total: N }
//                       key "dispensed"     -> { items: [{ tokenNum, ts, fp, addr }] }

import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405);
  }

  let body = {};
  try {
    if (req.method === "POST") {
      const text = await req.text();
      body = text ? JSON.parse(text) : {};
    }
  } catch (_) {
    body = {};
  }

  const offers = getStore("bepe-mint-offers");
  const queue = getStore("bepe-mint-queue");

  // Read queue with strong consistency so we have a fresh ETag for CAS.
  let q;
  let etag;
  try {
    const result = await queue.getWithMetadata("queue", { type: "json", consistency: "strong" });
    if (!result) {
      return json({ error: "not_initialized", message: "Mint queue has not been bootstrapped yet. Run scripts/upload_offers.mjs." }, 503);
    }
    q = result.data;
    etag = result.etag;
  } catch (err) {
    return json({ error: "queue_read_failed", detail: String(err) }, 500);
  }

  if (!q || !Array.isArray(q.shuffled)) {
    return json({ error: "queue_corrupt" }, 500);
  }

  if (q.counter >= q.shuffled.length) {
    return json({ error: "sold_out", remaining: 0 }, 410);
  }

  // Pop next token + fetch offer. If the offer text is missing in storage
  // (e.g., a partial bootstrap), advance the counter past it and try the next
  // one. Up to 30 skips to avoid wasting time but allow surviving a noisy
  // bootstrap. Each pop uses ETag-based CAS to prevent concurrent dispenses
  // handing out the same token.
  let tokenNum = null;
  let offerText = null;
  const skipped = [];
  const MAX_TRIES = 30;

  for (let outer = 0; outer < MAX_TRIES; outer++) {
    let popped = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      tokenNum = q.shuffled[q.counter];
      const next = { ...q, counter: q.counter + 1 };
      try {
        await queue.setJSON("queue", next, { onlyIfMatch: etag });
        popped = true;
        break;
      } catch (_) {
        const result = await queue.getWithMetadata("queue", { type: "json", consistency: "strong" });
        if (!result) return json({ error: "queue_lost" }, 500);
        q = result.data;
        etag = result.etag;
        if (q.counter >= q.shuffled.length) {
          return json({ error: "sold_out", remaining: 0, skipped }, 410);
        }
        tokenNum = null;
      }
    }
    if (!popped) {
      return json({ error: "queue_contention", skipped }, 503);
    }

    // Try to fetch the offer for this token.
    try {
      offerText = await offers.get(`offer/${pad(tokenNum)}`);
    } catch (err) {
      // Hard storage error — bail.
      return json({ error: "offer_read_failed", tokenNumber: tokenNum, detail: String(err) }, 500);
    }

    if (offerText && offerText.startsWith("offer1")) break;

    // Missing or malformed — log and try the next token.
    skipped.push(tokenNum);
    offerText = null;
    tokenNum = null;
    // Refresh queue snapshot before next loop.
    const result = await queue.getWithMetadata("queue", { type: "json", consistency: "strong" });
    if (!result) return json({ error: "queue_lost" }, 500);
    q = result.data;
    etag = result.etag;
    if (q.counter >= q.shuffled.length) {
      return json({ error: "sold_out", remaining: 0, skipped }, 410);
    }
  }

  if (!offerText) {
    return json({ error: "no_valid_offer_found", skipped, hint: "Re-run scripts/upload_offers.mjs --force to repopulate offers." }, 500);
  }

  // Generate a one-time claim token tied to this dispense. The frontend will
  // include it in /api/mint/confirm; the confirm endpoint validates the claim
  // matches the token number, then deletes it. This prevents anyone from
  // pumping the public mint counter by hitting /api/mint/confirm directly.
  const claimToken = randomToken();
  await queue.setJSON(`claims/${claimToken}`, {
    tokenNumber: tokenNum,
    ts: Date.now(),
    fp: typeof body.walletFingerprint === "string" ? body.walletFingerprint.slice(0, 32) : null,
  }).catch(err => console.warn("claim store failed:", err));

  // Audit log (best-effort, non-blocking failure).
  try {
    const dispensedEntry = {
      tokenNumber: tokenNum,
      ts: Date.now(),
      fp: typeof body.walletFingerprint === "string" ? body.walletFingerprint.slice(0, 32) : null,
      addr: typeof body.walletAddr === "string" ? body.walletAddr.slice(0, 80) : null,
    };
    const log = (await queue.get("dispensed", { type: "json" })) || { items: [] };
    log.items.push(dispensedEntry);
    if (log.items.length > 5000) log.items = log.items.slice(-5000);
    await queue.setJSON("dispensed", log);
  } catch (_) { /* not critical */ }

  return json({
    tokenNumber: tokenNum,
    offerText,
    remaining: Math.max(0, q.shuffled.length - q.counter - 1),
    claimToken,
  });
};

export const config = {
  path: "/api/mint/random",
};

function randomToken() {
  // 22 url-safe chars from crypto-grade randomness via globalThis.crypto.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(36).padStart(2, "0")).join("").slice(0, 22);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function pad(n) { return String(n).padStart(4, "0"); }
