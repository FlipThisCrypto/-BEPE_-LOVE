// Submit a wallet's best score for a game to the public leaderboard.
//
// Endpoint: POST /api/score/submit
// Body:    { game: "brawl"|"match", wallet: string, name?: string, score: number, ...meta }
// Returns: { ok: true, rank: number, total: number, kept?: bool }
//
// Per-wallet upsert: each wallet has at most one entry per game. On submit,
// the entry is replaced only if the new score is better (higher score, or
// same score with faster time for match game). Top 100 kept per game.
//
// v1: trust the wallet fingerprint as identity. No signature check. If real
// cheating shows up, layer in chia_signMessageByAddress verification later.

import { getStore } from "@netlify/blobs";

const STORE = "bepe-scores";
const MAX_ENTRIES = 100;
const MAX_RETRIES = 5;

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "invalid_body" }, 400); }

  const game = body?.game;
  const wallet = body?.wallet;
  const score = Number(body?.score);
  if (game !== "brawl" && game !== "match") return json({ error: "unknown_game" }, 400);
  if (!wallet || typeof wallet !== "string" || wallet.length > 64) return json({ error: "invalid_wallet" }, 400);
  if (!Number.isFinite(score) || score < 0 || score > 1_000_000) return json({ error: "invalid_score" }, 400);

  const name = sanitizeName(body?.name);
  const time = Number.isFinite(body?.time) ? Number(body.time) : null;
  const meta = pickMeta(body, game);

  const newEntry = { wallet, name, score, time, ...meta, ts: Date.now() };

  const store = getStore(STORE);
  const key = `leaderboard/${game}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const result = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
    const data = result?.data ?? { entries: [], updatedAt: 0 };
    const etag = result?.etag;

    const existingIdx = data.entries.findIndex(e => e.wallet === wallet);
    let kept = false;

    if (existingIdx >= 0) {
      const cur = data.entries[existingIdx];
      const isBetter = (
        newEntry.score > cur.score ||
        (game === "match" && newEntry.score === cur.score && (newEntry.time ?? Infinity) < (cur.time ?? Infinity))
      );
      if (!isBetter) {
        // Existing record stays
        kept = true;
        return json({ ok: true, kept: true, rank: existingIdx + 1, total: data.entries.length });
      }
      data.entries[existingIdx] = newEntry;
    } else {
      data.entries.push(newEntry);
    }

    // Sort: score desc, then for match the faster time wins
    data.entries.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (game === "match") return (a.time ?? Infinity) - (b.time ?? Infinity);
      return 0;
    });
    data.entries = data.entries.slice(0, MAX_ENTRIES);
    data.updatedAt = Date.now();

    try {
      const opts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
      await store.setJSON(key, data, opts);
      const finalRank = data.entries.findIndex(e => e.wallet === wallet) + 1;
      return json({
        ok: true,
        rank: finalRank > 0 ? finalRank : null,
        total: data.entries.length,
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
  path: "/api/score/submit",
};

function sanitizeName(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/[<>"'&]/g, "").trim().slice(0, 24);
}

function pickMeta(body, game) {
  if (game === "brawl") {
    return {
      wins: Number.isFinite(body.wins) ? Number(body.wins) : 0,
      matches: Number.isFinite(body.matches) ? Number(body.matches) : 0,
    };
  }
  return {
    pairs: Number.isFinite(body.pairs) ? Number(body.pairs) : 0,
    difficulty: typeof body.difficulty === "string" ? body.difficulty.slice(0, 12) : null,
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
