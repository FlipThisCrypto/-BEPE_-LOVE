// Public leaderboard read for a given game.
//
// Endpoint: GET /api/score/top?game=brawl|match&limit=20&wallet=<fingerprint>
// Returns: { game, top: [...], total, myRank?, me? }

import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const game = url.searchParams.get("game") || "brawl";
  const limit = clamp(parseInt(url.searchParams.get("limit") || "20", 10), 1, 100);
  const wallet = url.searchParams.get("wallet");

  if (game !== "brawl" && game !== "match") return json({ error: "unknown_game" }, 400);

  const store = getStore("bepe-scores");
  const data = await store.get(`leaderboard/${game}`, { type: "json" });
  const entries = data?.entries ?? [];

  let myRank = null;
  let me = null;
  if (wallet) {
    const idx = entries.findIndex(e => e.wallet === wallet);
    if (idx >= 0) {
      myRank = idx + 1;
      me = entries[idx];
    }
  }

  return json({
    game,
    top: entries.slice(0, limit),
    total: entries.length,
    myRank,
    me,
    updatedAt: data?.updatedAt ?? 0,
  });
};

export const config = {
  path: "/api/score/top",
};

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo)); }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=15" },
  });
}
