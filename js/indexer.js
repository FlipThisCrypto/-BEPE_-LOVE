// Chia NFT indexer wrapper. Fetches NFTs owned by an address from MintGarden's
// public API. Used to power the "Play with my Bepes" filter — Chia's
// WalletConnect doesn't expose chia_getNFTs, so a third-party indexer is the
// only way today.
//
// Caches results in sessionStorage for 5 minutes so we don't hammer the API.

import { loadManifest } from "./data.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_PREFIX = "bepe.indexer.";

// Bepe Love collection identifier from the metadata.
const COLLECTION_ID = "299d9670-6505-4854-bbd2-939dcdafb90e";

const MINTGARDEN_BASE = "https://api.mintgarden.io";

// Map a fingerprint OR bech32 address to owned Bepe IDs.
// MintGarden's primary lookup is by address (xch1...). If we only have a
// fingerprint, we fall back to fetching wallet addresses via WalletConnect
// (caller's responsibility — this module just takes whatever address it gets).
export async function getOwnedBepes(addressOrXch) {
  if (!addressOrXch) return [];

  const cacheKey = `${CACHE_PREFIX}${addressOrXch}`;
  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      const { ts, ids } = JSON.parse(cached);
      if (Date.now() - ts < CACHE_TTL_MS) return ids;
    }
  } catch (_) {}

  let ids = [];
  try {
    ids = await fetchFromMintGarden(addressOrXch);
  } catch (err) {
    console.warn("MintGarden lookup failed:", err);
    return [];
  }

  try {
    sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), ids }));
  } catch (_) {}

  return ids;
}

// Resolve owned Bepes against the local manifest, returning full NFT records.
export async function getOwnedBepeRecords(addressOrXch) {
  const [manifest, ownedIds] = await Promise.all([
    loadManifest(),
    getOwnedBepes(addressOrXch),
  ]);
  if (!ownedIds.length) return [];
  // ownedIds are token numbers (1..2222) per Bepe Love's identifier.
  // MintGarden may return them as strings; normalize.
  const idSet = new Set(ownedIds.map(Number));
  return manifest.filter(nft => idSet.has(nft.id));
}

// ---------- private ----------

async function fetchFromMintGarden(address) {
  // MintGarden API: GET /addresses/{address}/nfts?collection={id}
  // Returns an array; we extract the Bepe Love token numbers.
  const url = `${MINTGARDEN_BASE}/addresses/${encodeURIComponent(address)}/nfts?collection=${encodeURIComponent(COLLECTION_ID)}&size=100`;
  const ids = [];
  let next = url;
  let pageCount = 0;
  while (next && pageCount < 30) {
    const res = await fetch(next, { headers: { accept: "application/json" } });
    if (!res.ok) {
      // 404 or no NFTs — empty result.
      if (res.status === 404) return [];
      throw new Error(`MintGarden API ${res.status}`);
    }
    const body = await res.json();
    const items = Array.isArray(body) ? body : (body.items ?? body.nfts ?? body.results ?? []);
    for (const it of items) {
      const id = extractTokenNumber(it);
      if (id != null) ids.push(id);
    }
    // Pagination — MintGarden uses `next` cursor or `next_url`.
    next = body.next ?? body.next_url ?? null;
    pageCount += 1;
  }
  return ids;
}

function extractTokenNumber(item) {
  // Try a few common shapes from indexer APIs.
  // 1. Direct field on item
  if (item.token_number != null) return Number(item.token_number);
  if (item.tokenNumber != null) return Number(item.tokenNumber);
  // 2. Under metadata.attributes (CHIP-0015 layout)
  const attrs = item.metadata?.attributes ?? item.data?.metadata?.attributes ?? null;
  if (Array.isArray(attrs)) {
    const tn = attrs.find(a => /token.?number/i.test(a.trait_type ?? a.traitType ?? ""));
    if (tn?.value != null) return Number(tn.value);
  }
  // 3. CHIP-0015 identifier under data.identifier
  const ident = item.metadata?.data?.identifier?.value ?? item.data?.identifier?.value;
  if (ident != null) return Number(ident);
  // 4. Parse from the NFT name "Bepe Love #0237"
  const name = item.name ?? item.metadata?.name;
  if (typeof name === "string") {
    const m = name.match(/#\s*(\d+)/);
    if (m) return Number(m[1]);
  }
  return null;
}
