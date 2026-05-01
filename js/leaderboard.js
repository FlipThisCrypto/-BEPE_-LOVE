// Renders a public leaderboard panel for a given game (brawl|match).
// Highlights the connected wallet's row when present.

import { getAddressInfo } from "./wallet.js";

const TOP_API = "/api/score/top";

export async function renderLeaderboard(game, mountSelector, opts = {}) {
  const mount = document.querySelector(mountSelector);
  if (!mount) return;
  const limit = opts.limit ?? 20;
  const info = getAddressInfo();
  const params = new URLSearchParams({ game, limit: String(limit) });
  if (info?.fingerprint) params.set("wallet", info.fingerprint);

  mount.innerHTML = `<p class="lb-status">Loading leaderboard…</p>`;
  let data;
  try {
    const res = await fetch(`${TOP_API}?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    mount.innerHTML = `<p class="lb-status muted">Couldn't load leaderboard. (${err.message})</p>`;
    return;
  }

  const entries = data.top || [];
  if (!entries.length) {
    mount.innerHTML = `
      <p class="lb-status muted">
        No scores yet. ${info ? "Play a round and you'll be the first on the board." : "Connect a wallet, play a round — you'll be the first on the board."}
      </p>
    `;
    return;
  }

  const myWallet = info?.fingerprint;
  const isMatch = game === "match";

  mount.innerHTML = `
    <div class="lb-meta">
      <span>${data.total} player${data.total === 1 ? "" : "s"}</span>
      ${data.myRank ? `<span class="lb-myrank">Your rank: <b>#${data.myRank}</b></span>` : (info ? `<span class="muted">Submit a score to appear here</span>` : `<span class="muted">Connect a wallet to track your rank</span>`)}
    </div>
    <ol class="lb-list">
      ${entries.map((e, i) => {
        const rank = i + 1;
        const me = myWallet && e.wallet === myWallet;
        const display = (e.name && e.name.trim()) || `fp ${e.wallet}`;
        const sub = isMatch
          ? `${e.pairs} pairs · ${formatTime(e.time)}`
          : `${e.wins ?? 0}W / ${e.matches ?? 0} matches`;
        const scoreLabel = isMatch ? `${e.score} pts` : `${e.score}`;
        const scoreUnit = isMatch ? "" : (e.score === 1 ? " win streak" : " streak");
        return `
          <li class="lb-row${me ? " me" : ""}${rank <= 3 ? " medal-" + rank : ""}">
            <span class="lb-rank">${rank <= 3 ? medal(rank) : "#" + rank}</span>
            <span class="lb-name">${escapeHtml(display)}</span>
            <span class="lb-sub">${escapeHtml(sub)}</span>
            <span class="lb-score">${scoreLabel}<span class="lb-unit">${scoreUnit}</span></span>
          </li>
        `;
      }).join("")}
    </ol>
  `;
}

function medal(rank) {
  return rank === 1 ? "🥇" : rank === 2 ? "🥈" : "🥉";
}

function formatTime(ms) {
  if (typeof ms !== "number" || ms <= 0) return "—";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
