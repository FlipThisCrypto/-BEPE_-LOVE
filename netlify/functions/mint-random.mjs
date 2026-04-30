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

  // Pop next token number with optimistic concurrency. Up to 5 retries on
  // contention.
  let tokenNum = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    tokenNum = q.shuffled[q.counter];
    const next = { ...q, counter: q.counter + 1 };
    try {
      await queue.setJSON("queue", next, { onlyIfMatch: etag });
      break;
    } catch (err) {
      // Conflict — re-read and try again.
      const result = await queue.getWithMetadata("queue", { type: "json", consistency: "strong" });
      if (!result) return json({ error: "queue_lost" }, 500);
      q = result.data;
      etag = result.etag;
      if (q.counter >= q.shuffled.length) {
        return json({ error: "sold_out", remaining: 0 }, 410);
      }
      tokenNum = null;
      if (attempt === 4) return json({ error: "queue_contention" }, 503);
    }
  }

  if (tokenNum == null) {
    return json({ error: "queue_failed" }, 500);
  }

  // Fetch the offer text.
  const key = `offer/${pad(tokenNum)}`;
  let offerText;
  try {
    offerText = await offers.get(key);
  } catch (err) {
    return json({ error: "offer_read_failed", tokenNumber: tokenNum, detail: String(err) }, 500);
  }
  if (!offerText) {
    // Queue advanced but the offer is missing — log + fail this attempt.
    return json({ error: "offer_missing", tokenNumber: tokenNum }, 500);
  }

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
  });
};

export const config = {
  path: "/api/mint/random",
};

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
