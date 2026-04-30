# Bepe Love — website + auto-battler

The official site for the **Bepe Love** NFT collection on Chia. A 2,222-piece generative
collection — wizard culture, Tang Gang energy, $LOVE token. Plus an in-browser
card auto-battler that uses every NFT as a playable card.

Static site. Hosted on Netlify. No backend.

## Stack

- Plain HTML / CSS / vanilla ES modules. No framework, no build step for the runtime.
- Python build scripts (Pillow) generate the data manifest and resize images.
- Netlify for hosting + CDN.

## Project layout

```
site/
├── index.html              # landing page
├── play.html               # auto-battler (Phase 2 stub for now)
├── css/base.css            # all styles
├── js/
│   ├── data.js             # shared manifest loader, tier/element helpers
│   └── landing.js          # hero carousel, gallery, card-stack
├── data/
│   ├── nfts.json           # generated manifest (2,222 entries)
│   └── stats.json          # generated rollup for hero stats
├── images/
│   ├── thumb/{0001..2222}.webp   # 240px gallery thumbs (~8 KB each)
│   └── card/ {0001..2222}.webp   # 640px card art (~37 KB each)
├── assets/                 # music, video, posters
├── scripts/
│   ├── build_manifest.py   # metadata → nfts.json + stats.json
│   └── build_images.py     # source PNGs → webp variants
├── netlify.toml
└── README.md
```

## Rarity tiers

Mapped from `rarity_rank` in the metadata. Tang Gang / Wizard themed:

| Tier         | Rank range | Count |
|--------------|------------|-------|
| Tang Lord    | 1–22       | 22    |
| Tang Mage    | 23–222     | 200   |
| Wizard       | 223–666    | 444   |
| Apprentice   | 667–1500   | 834   |
| Pleb         | 1501–2222  | 722   |

## Game elements

Background trait → element. Rock-paper-scissors style matchups (planned for the brawl resolver):

| Element | Backgrounds                                                       |
|---------|-------------------------------------------------------------------|
| 🔥 Fire | Bullflare Orange, Gooey Spellfield Orange, Arcade Orange          |
| 💧 Water | Dennis Voltage Blue, SpaceScan Spell Blue, Conlive Aqua Signal   |
| 🌿 Nature | Taylored Garden Green, MintGarden Glow                          |
| ✨ Light | Sandy Shore Blush, Gilded Talk Gold                              |
| 🔮 Arcane | Haze Violet, Abandon Alley Gray (default for unmapped)          |

## Local development

```bash
# (one-time) regenerate data + images from source assets in ../Bepe Love generated/
python scripts/build_manifest.py
python scripts/build_images.py

# serve locally
python -m http.server 8000
# open http://localhost:8000
```

The build scripts are idempotent — `build_images.py` skips files that already exist.

## Deploy (Netlify)

1. Push this repo to GitHub.
2. In Netlify: **Add new site → Import an existing project → GitHub → -BEPE_-LOVE**.
3. Build command: leave blank. Publish directory: `.` (or wherever `index.html` lives).
4. `netlify.toml` already configures cache headers, the functions directory, and pretty-URL redirects.

## Mint dispenser bootstrap (one-time)

The Random Mint button serves offer files from Netlify Blobs. Before the
first deploy that exposes the mint, you need to upload the `.offer` files
and initialize the queue. This runs locally — never check the offers into
the repo (it's public; committing them defeats the random dispenser).

### Prereqs

- Node 18+ installed
- The 2,220 `.offer` files in a directory (default: `../offers/` relative to `site/`)
- A Netlify personal access token: https://app.netlify.com/user/applications → New access token
- Your Netlify site ID: dashboard → Site settings → Site information → Site ID

### Run

```bash
cd site
npm install

NETLIFY_AUTH_TOKEN=<your-token> NETLIFY_SITE_ID=<your-site-id> \
  node scripts/upload_offers.mjs --offers ../offers
```

The script:
1. Reads every `bepe_love_NNNN.offer` from the directory.
2. Uploads each to a Blobs store (`bepe-mint-offers`, key `offer/<NNNN>`).
3. Builds a randomly-shuffled queue and writes it to `bepe-mint-queue` / `queue`.

It's safe to re-run for individual offer uploads (overwrite is idempotent).
**The queue is only initialized once** to avoid resetting a live mint —
pass `--force-queue` to override.

### After bootstrap

`/api/mint/random` is live as soon as Netlify deploys the function. Visit
the landing page, connect a Chia wallet, click **Mint a Random Bepe**.

### Endpoints

- `POST /api/mint/random` — pops next offer, returns `{ tokenNumber, offerText, remaining }`
- `GET  /api/mint/status` — read-only stats, returns `{ initialized, total, dispensed, remaining, recent }`

## Roadmap

- ✅ **Phase 0** — manifest + image pipeline + project structure
- ✅ **Phase 1** — landing page, hero carousel, filterable gallery, scroll card-stack
- ✅ **Phase 2** — Bepe Brawl auto-battler (Quick Brawl + Pick Your Hand → 3-round resolution → local leaderboard with W/L/D, streak, recent history)
- ✅ **Phase 4** — Bepe Match (kid-friendly trait-matching memory game, three difficulties, timed scoring, completion bonus, miss penalty, best-score / best-time tracking)
- ✅ **Phase 3a** — Chia WalletConnect login. QR pairing modal, session restore, wallet-namespaced score storage (per-fingerprint). MintGarden indexer lookup powers a "⭐ My Bepes" filter on the Brawl picker so you can play with the Bepes you actually own.
- ✅ **Phase 3b** — Random Mint dispenser. Netlify Function backed by Netlify Blobs serves a shuffled queue of 2,220 secure-the-mint offer files (the user's two test mints — #0001 and #0085 — are already excluded). Mint button on landing page tries `chia_takeOffer` via WalletConnect first, falls back to a downloaded `.offer` file with step-by-step instructions. **2 XCH** per Bepe, SplitXCH 25/25/25/25 baked into every offer.

### Wallet Connect

- Plain ES modules, no build step. `@walletconnect/sign-client@2.13.0` and `qrcode@1.5.4` loaded via `https://esm.sh`.
- Project ID: `04650e37bf0643ffe10266d3d9e413b8` (client-visible by design — WalletConnect Cloud rate-limits per origin).
- Required RPC: `chia_logIn`. Optional: `chia_getCurrentAddress`, `chia_getNextAddress`, `chia_getWallets`, `chia_getWalletBalance`, `chia_takeOffer`, `chia_signMessageByAddress`. The `chia_takeOffer` request is staged for Phase 3b's mint flow but listed under optional namespaces so wallets without it still pair cleanly.
- Score storage namespaces by wallet fingerprint. When connected, all writes go to `bepe.scores.<fingerprint>.v1`; when disconnected, to `bepe.scores.anon.v1`. Legacy `bepe.scores.v1` is auto-migrated on first load.

### Bepe Brawl mechanics

- **Power**: each Bepe's `points` from metadata is the base score
- **Element wheel**: Fire > Nature > Water > Fire (cycle); Light ↔ Arcane (clash); same element = mirror
- **Element bonus**: +50 advantage / +30 clash / +5 mirror
- **Trait abilities**: rare accessories and patches add round modifiers (Foundation Halo +20 self, Asters Wand +25 self, Hyper Hex Lasers +30 self, FOMO Flame Patch −15 opp, etc.)
- **Match**: best of three rounds; AI opponent drafts a hand within ±25% of your average rank for fair-but-unpredictable matchups
- **Persistence**: all results route through `js/score-store.js` so the localStorage backend can be swapped for wallet-linked storage in one file

### Bepe Match mechanics

- **Mechanic**: classic Memory, but pairs match by *trait value*, not identity. Two cards match if they share the round's announced trait (e.g., both have jacket = "Love Club Jacket"). Different NFTs, same trait — teaches kids the trait vocabulary.
- **Difficulties**: Easy (6 pairs / background or jacket), Medium (8 pairs / eyes, patch, accessory), Hard (12 pairs / mouth, face, patch).
- **Trait roulette**: each round randomly picks an eligible trait category from the difficulty pool — replay value.
- **Scoring**: `Math.max(50, 500 - secondsSinceLastMatch * 25)` per pair, −10 per miss, +50 × pairs completion bonus.
- **Stats tracked**: rounds played, best score, fastest time, last 6 rounds — same `score-store.js` abstraction as Brawl.

## Source assets (not committed)

The 5 GB of original 2048×2048 PNGs and the 247 MB raw video live outside the repo
(in the parent `Bepe Love generated/` directory). They are not committed because
they exceed reasonable repo size — they're regenerated on demand via the build
scripts and ultimately distributed via IPFS at mint time.

## License

Art and brand: © Bepe Love. Code: MIT.
