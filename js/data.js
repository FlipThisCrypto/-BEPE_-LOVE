// Shared NFT data loader. Caches the manifest in-memory across pages.

const MANIFEST_URL = "data/nfts.json";
const STATS_URL = "data/stats.json";

let _manifest = null;
let _stats = null;

export async function loadManifest() {
  if (_manifest) return _manifest;
  const res = await fetch(MANIFEST_URL);
  if (!res.ok) throw new Error(`Failed to load ${MANIFEST_URL}: ${res.status}`);
  _manifest = await res.json();
  return _manifest;
}

export async function loadStats() {
  if (_stats) return _stats;
  const res = await fetch(STATS_URL);
  if (!res.ok) throw new Error(`Failed to load ${STATS_URL}: ${res.status}`);
  _stats = await res.json();
  return _stats;
}

export function tierClass(tier) {
  return tier.toLowerCase().replace(/\s+/g, "-");
}

export function elementClass(element) {
  return element.toLowerCase();
}

export function pickRandom(arr, n) {
  const copy = arr.slice();
  const out = [];
  while (out.length < n && copy.length) {
    const i = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(i, 1)[0]);
  }
  return out;
}

// Stable pseudo-shuffle for "featured" sorts that don't change every reload (yet).
export function topByPoints(manifest, n) {
  return manifest.slice().sort((a, b) => b.points - a.points).slice(0, n);
}
