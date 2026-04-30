// Read-only status of the mint dispenser.
//
// Endpoint: GET /api/mint/status
// Returns: { initialized: boolean, total: number, dispensed: number, remaining: number, recent: [{ tokenNumber, ts }, ...] }

import { getStore } from "@netlify/blobs";

export default async () => {
  const queue = getStore("bepe-mint-queue");
  const q = await queue.get("queue", { type: "json" });
  if (!q) {
    return json({ initialized: false, total: 0, dispensed: 0, remaining: 0, recent: [] });
  }
  const log = (await queue.get("dispensed", { type: "json" })) || { items: [] };
  const recent = (log.items || []).slice(-10).reverse().map(it => ({
    tokenNumber: it.tokenNumber,
    ts: it.ts,
  }));
  return json({
    initialized: true,
    total: q.total ?? q.shuffled?.length ?? 0,
    dispensed: q.counter ?? 0,
    remaining: Math.max(0, (q.shuffled?.length ?? 0) - (q.counter ?? 0)),
    recent,
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
