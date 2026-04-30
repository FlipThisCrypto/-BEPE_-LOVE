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
