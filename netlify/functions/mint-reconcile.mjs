// Scheduled function: reconciles confirmed-set + pending-set against
// Mintgarden's on-chain data every 10 minutes.
//
// This is the same logic as admin-bootstrap's "audit-on-chain" action,
// but runs automatically on Netlify's scheduler — no admin secret
// required because it's invoked only by Netlify, not by the public.
//
// Behavior:
//   - Pulls the current on-chain owned set from Mintgarden
//   - Replaces confirmed-set with that exact set (drift correction)
//   - Promotes pending entries that are now on-chain → confirmed
//   - Drops pending entries older than 1 hour that never reached chain
//     (releases the slot back to the dispenser pool)
//
// The combination of "mint-confirm writes to pending" + "this scheduled
// audit promotes only on-chain to confirmed" closes the "Sage approved
// but chain didn't broadcast" counter-pumping exploit.

import { getStore } from "@netlify/blobs";

const COLLECTION_ID = "col15pq4u6mhqhqfpk8ysvjz2uln7lkleym6uxw4puu4vc45r9n0wv0qp7rhp7";
const MG = "https://api.mintgarden.io";
const PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour

export default async () => {
  const queue = getStore("bepe-mint-queue");
  const now = Date.now();
  const t0 = Date.now();

  // 1. Pull every currently-held NFT in the collection from Mintgarden.
  const ownersRes = await fetch(`${MG}/collections/${COLLECTION_ID}/nfts/owners`);
  if (!ownersRes.ok) {
    console.warn(`mintgarden owners ${ownersRes.status}`);
    return new Response("mintgarden_failed", { status: 502 });
  }
  const ownersList = await ownersRes.json();
  const ownedLaunchers = new Set();
  for (const o of (Array.isArray(ownersList) ? ownersList : [])) {
    if (o?.encoded_id) ownedLaunchers.add(o.encoded_id);
  }

  // 2. Paginate the collection list to map launcher → token_number.
  const launcherToToken = new Map();
  let cursor = null;
  for (let page = 0; page < 30; page++) {
    const params = new URLSearchParams({ size: "100" });
    if (cursor) params.set("page", cursor);
    const listRes = await fetch(`${MG}/collections/${COLLECTION_ID}/nfts?${params}`);
    if (!listRes.ok) break;
    const listData = await listRes.json();
    const items = listData?.items || [];
    if (!items.length) break;
    for (const n of items) {
      const launcher = n?.encoded_id;
      const name = typeof n?.name === "string" ? n.name : "";
      const m = name.match(/#\s*(\d+)/);
      if (launcher && m) launcherToToken.set(launcher, parseInt(m[1], 10));
    }
    cursor = listData?.next;
    if (!cursor) break;
  }

  // 3. On-chain token set.
  const onChainTokens = new Set();
  for (const launcher of ownedLaunchers) {
    const tok = launcherToToken.get(launcher);
    if (typeof tok === "number" && tok >= 1 && tok <= 2222) {
      onChainTokens.add(tok);
    }
  }

  // 4. Replace confirmed-set.
  const sortedTokens = [...onChainTokens].sort((a, b) => a - b);
  const entries = sortedTokens.map(t => ({
    tokenNumber: t,
    ts: now,
    source: "mint-reconcile",
  }));
  await queue.setJSON("confirmed-set", { tokens: sortedTokens, entries });

  // 5. Filter pending-set.
  const pendingRaw = await queue.get("pending-set", { type: "json" });
  const pending = pendingRaw?.entries ?? [];
  const stillPending = pending.filter(p => {
    if (onChainTokens.has(p.tokenNumber)) return false; // graduated
    if (now - (p.ts ?? 0) > PENDING_TTL_MS) return false; // expired
    return true;
  });
  const promoted = pending.length - stillPending.length;
  await queue.setJSON("pending-set", { entries: stillPending });

  const elapsed = Date.now() - t0;
  console.log(JSON.stringify({
    msg: "mint-reconcile",
    onChain: sortedTokens.length,
    pendingBefore: pending.length,
    pendingAfter: stillPending.length,
    promoted,
    elapsedMs: elapsed,
  }));

  return new Response(JSON.stringify({
    ok: true,
    onChain: sortedTokens.length,
    pendingAfter: stillPending.length,
    promoted,
    elapsedMs: elapsed,
  }), { headers: { "content-type": "application/json" } });
};

export const config = {
  // Netlify scheduled function. Cron: every 10 minutes.
  // https://docs.netlify.com/functions/scheduled-functions/
  schedule: "*/10 * * * *",
};
