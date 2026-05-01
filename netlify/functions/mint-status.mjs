// Read-only status of the mint dispenser + confirmed mints.
//
// Total = the full collection size (hardcoded).
// Minted = confirmed-set count + tokens that were minted before the dispenser
//          existed (your test mints of #0001 and #0085).
// Remaining = total - minted.
//
// This is the source of truth for the user-facing counter. The dispenser's
// internal queue counter is a separate concern and exposed under `queue.*`
// for diagnostics only.
//
// Endpoint: GET /api/mint/status

import { getStore } from "@netlify/blobs";

const COLLECTION_TOTAL = 2222;
// Pre-bootstrap mints used to live as a hardcoded constant. Now they're
// expected to be present in the confirmed-set itself (seeded via
// /api/admin/bootstrap "set-confirmed"). Set is the single source of truth.
const PRE_MINTED = [];

export default async () => {
  const queue = getStore("bepe-mint-queue");
  const offers = getStore("bepe-mint-offers");

  const [confirmedRaw, q, log] = await Promise.all([
    queue.get("confirmed-set", { type: "json" }),
    queue.get("queue", { type: "json" }),
    queue.get("dispensed", { type: "json" }),
  ]);

  const confirmed = confirmedRaw?.tokens ?? [];
  const minted = confirmed.length + PRE_MINTED.length;
  const remaining = Math.max(0, COLLECTION_TOTAL - minted);

  // Diagnostic: count blobs in the offers store. Best-effort.
  let offerCount = 0;
  try {
    let cursor = undefined;
    do {
      const page = await offers.list({ cursor });
      offerCount += page.blobs.length;
      cursor = page.cursor;
    } while (cursor);
  } catch (_) {}

  // Recent confirmed mints (last 10) for an activity ticker.
  const recentEntries = (confirmedRaw?.entries ?? []).slice(-10).reverse().map(e => ({
    tokenNumber: e.tokenNumber,
    ts: e.ts,
  }));

  return json({
    // User-facing
    total: COLLECTION_TOTAL,
    minted,
    remaining,
    confirmedViaSite: confirmed.length,
    preMinted: PRE_MINTED.length,
    recent: recentEntries,

    // Diagnostic
    queue: q ? {
      total: q.total ?? q.shuffled?.length ?? 0,
      counter: q.counter ?? 0,
      remaining: Math.max(0, (q.shuffled?.length ?? 0) - (q.counter ?? 0)),
    } : null,
    offerCount,
    queueOffersAligned: q ? offerCount === q.total : false,
    initialized: !!q,

    // Legacy fields (frontend code that wasn't updated still reads these)
    dispensed: minted,
  });
};

export const config = {
  path: "/api/mint/status",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store, max-age=0" },
  });
}
