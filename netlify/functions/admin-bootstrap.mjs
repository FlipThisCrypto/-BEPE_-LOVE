// One-shot admin endpoint for the local upload script. Runs inside Netlify's
// runtime, so Blobs auth is automatic (no PAT permission gymnastics).
//
// Auth: shared secret via env var MINT_BOOTSTRAP_SECRET. Set it in the
// Netlify dashboard (Site -> Environment variables) to any long random string.
// Pass the same value as { secret } in the body of every request.
//
// Actions:
//   POST { secret, action: "upload-batch", offers: [{tokenNum, text}, ...] }
//   POST { secret, action: "init-queue", tokenNumbers: [N, N, ...], force?: bool }
//   POST { secret, action: "status" }
//   POST { secret, action: "wipe" }   <- nukes queue + dispensed log; offers remain

import { getStore } from "@netlify/blobs";

const SECRET = process.env.MINT_BOOTSTRAP_SECRET;

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!SECRET) {
    return json({
      error: "secret_not_configured",
      hint: "Set MINT_BOOTSTRAP_SECRET in Netlify dashboard -> Site -> Environment variables, then redeploy.",
    }, 503);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_body" }, 400);
  }

  if (typeof body?.secret !== "string" || body.secret !== SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  const offers = getStore("bepe-mint-offers");
  const queue = getStore("bepe-mint-queue");

  try {
    if (body.action === "upload-batch") {
      if (!Array.isArray(body.offers)) return json({ error: "missing_offers" }, 400);
      let uploaded = 0, skipped = 0;
      for (const o of body.offers) {
        if (typeof o?.tokenNum !== "number" || typeof o?.text !== "string" || !o.text.startsWith("offer1")) {
          skipped++; continue;
        }
        const key = `offer/${String(o.tokenNum).padStart(4, "0")}`;
        await offers.set(key, o.text, {
          metadata: { tokenNum: o.tokenNum, uploadedAt: new Date().toISOString() },
        });
        uploaded++;
      }
      return json({ ok: true, uploaded, skipped });
    }

    if (body.action === "init-queue") {
      const existing = await queue.get("queue", { type: "json" });
      if (existing && !body.force) {
        return json({ ok: false, reason: "queue_exists", existing: { total: existing.total, counter: existing.counter } });
      }
      if (!Array.isArray(body.tokenNumbers)) return json({ error: "missing_tokenNumbers" }, 400);
      const shuffled = body.tokenNumbers.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      await queue.setJSON("queue", {
        shuffled, counter: 0, total: shuffled.length, initializedAt: new Date().toISOString(),
      });
      await queue.setJSON("dispensed", { items: [] });
      return json({ ok: true, initialized: shuffled.length });
    }

    if (body.action === "status") {
      const q = await queue.get("queue", { type: "json" });
      return json({
        initialized: !!q,
        total: q?.total ?? 0,
        counter: q?.counter ?? 0,
        remaining: q ? Math.max(0, q.shuffled.length - q.counter) : 0,
      });
    }

    if (body.action === "wipe") {
      await queue.delete("queue").catch(() => {});
      await queue.delete("dispensed").catch(() => {});
      return json({ ok: true, wiped: true });
    }

    // Replace the confirmed-set with an explicit list of token numbers.
    // Use this to repair drift (e.g., when /api/mint/confirm got spammed).
    // Body: { secret, action: "set-confirmed", tokens: [1, 85, 237, ...] }
    if (body.action === "set-confirmed") {
      if (!Array.isArray(body.tokens)) return json({ error: "missing_tokens" }, 400);
      const tokens = [...new Set(
        body.tokens
          .map(Number)
          .filter(n => Number.isInteger(n) && n >= 1 && n <= 2222)
      )].sort((a, b) => a - b);
      const entries = tokens.map(t => ({ tokenNumber: t, ts: Date.now(), source: "admin-set" }));
      await queue.setJSON("confirmed-set", { tokens, entries });
      return json({ ok: true, totalConfirmed: tokens.length, tokens });
    }

    if (body.action === "wipe-confirmed") {
      await queue.delete("confirmed-set").catch(() => {});
      return json({ ok: true, wiped: "confirmed-set" });
    }

    // Reconcile the ledger with on-chain reality.
    //
    // Queries Mintgarden's bulk owners endpoint (authoritative "what's actually
    // been minted") and replaces our confirmed-set with that exact set. Also
    // resets queue.counter to 0 and clears reservations so the dispenser
    // re-scans the full shuffled list from the start.
    //
    // Use this to recover burned slots after a dispenser exploit or any other
    // drift between the ledger and on-chain reality. Idempotent — safe to run
    // multiple times.
    //
    // Body: { secret, action: "audit-on-chain", collectionId?: string }
    if (body.action === "audit-on-chain") {
      const COLLECTION_ID = body.collectionId
        || "col15pq4u6mhqhqfpk8ysvjz2uln7lkleym6uxw4puu4vc45r9n0wv0qp7rhp7";
      const MG = "https://api.mintgarden.io";

      // 1. Pull every currently-held NFT in the collection.
      const ownersRes = await fetch(`${MG}/collections/${COLLECTION_ID}/nfts/owners`);
      if (!ownersRes.ok) {
        return json({ error: "mintgarden_owners_failed", status: ownersRes.status }, 502);
      }
      const ownersList = await ownersRes.json();
      const ownedLaunchers = new Set();
      for (const o of (Array.isArray(ownersList) ? ownersList : [])) {
        if (o?.encoded_id) ownedLaunchers.add(o.encoded_id);
      }

      // 2. Paginate the collection list to map launcher_id -> token_number
      //    (via the NFT name, e.g. "Bepe Love #1247" -> 1247).
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
          if (launcher && m) {
            launcherToToken.set(launcher, parseInt(m[1], 10));
          }
        }
        cursor = listData?.next;
        if (!cursor) break;
      }

      // 3. Build the actually-minted token set.
      const onChainTokens = new Set();
      for (const launcher of ownedLaunchers) {
        const tok = launcherToToken.get(launcher);
        if (typeof tok === "number" && tok >= 1 && tok <= 2222) {
          onChainTokens.add(tok);
        }
      }

      // 4. Read what the ledger said before, for the summary diff.
      const beforeConfirmed = await queue.get("confirmed-set", { type: "json" });
      const beforeTokens = new Set(beforeConfirmed?.tokens ?? []);

      // 5. Write the new confirmed-set = on-chain truth.
      const sortedTokens = [...onChainTokens].sort((a, b) => a - b);
      const now = Date.now();
      const entries = sortedTokens.map(t => ({
        tokenNumber: t,
        ts: now,
        source: "audit-on-chain",
      }));
      await queue.setJSON("confirmed-set", { tokens: sortedTokens, entries });

      // 6. Reset queue counter to 0 so the dispenser re-scans from the start
      //    (recovering burned slots that are NOT actually on-chain).
      const qResult = await queue.getWithMetadata("queue", { type: "json", consistency: "strong" });
      let counterReset = false;
      if (qResult?.data && Array.isArray(qResult.data.shuffled)) {
        const reset = { ...qResult.data, counter: 0 };
        try {
          await queue.setJSON("queue", reset, { onlyIfMatch: qResult.etag });
          counterReset = true;
        } catch (_) { /* CAS conflict — try once more */
          const r2 = await queue.getWithMetadata("queue", { type: "json", consistency: "strong" });
          if (r2?.data) {
            try {
              await queue.setJSON("queue", { ...r2.data, counter: 0 }, { onlyIfMatch: r2.etag });
              counterReset = true;
            } catch (_) {}
          }
        }
      }

      // 7. Clear all reservations (stale draws shouldn't survive a reset).
      await queue.delete("reservations").catch(() => {});

      // 8. Wipe the dispensed audit log — stale data from the burned-slot era.
      await queue.delete("dispensed").catch(() => {});

      // Summary: what changed?
      const added = sortedTokens.filter(t => !beforeTokens.has(t));      // newly locked
      const removed = [...beforeTokens].filter(t => !onChainTokens.has(t)); // recovered

      return json({
        ok: true,
        onChainTotal: sortedTokens.length,
        ledgerBefore: beforeTokens.size,
        ledgerAfter: sortedTokens.length,
        addedToLedger: added.length,
        recoveredToPool: removed.length,
        counterReset,
        reservationsCleared: true,
        availableForMint: 2222 - sortedTokens.length,
      });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (err) {
    return json({ error: "internal", detail: String(err.message || err) }, 500);
  }
};

export const config = {
  path: "/api/admin/bootstrap",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
