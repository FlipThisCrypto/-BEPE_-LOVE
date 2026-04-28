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
4. `netlify.toml` already configures cache headers for `images/`, `data/`, `css/`, `js/`.

## Roadmap

- ✅ **Phase 0** — manifest + image pipeline + project structure
- ✅ **Phase 1** — landing page, hero carousel, filterable gallery, scroll card-stack
- ✅ **Phase 2** — Bepe Brawl auto-battler (Quick Brawl + Pick Your Hand → 3-round resolution → local leaderboard with W/L/D, streak, recent history)
- 🔜 **Phase 3** — Chia wallet connect (Goby), play with the cards you actually own, real mint link
- 🔜 **Phase 4** — Match game (kid-friendly trait-matching, timed scoring; localStorage now, wallet-linked when Phase 3 lands)

### Bepe Brawl mechanics

- **Power**: each Bepe's `points` from metadata is the base score
- **Element wheel**: Fire > Nature > Water > Fire (cycle); Light ↔ Arcane (clash); same element = mirror
- **Element bonus**: +50 advantage / +30 clash / +5 mirror
- **Trait abilities**: rare accessories and patches add round modifiers (Foundation Halo +20 self, Asters Wand +25 self, Hyper Hex Lasers +30 self, FOMO Flame Patch −15 opp, etc.)
- **Match**: best of three rounds; AI opponent drafts a hand within ±25% of your average rank for fair-but-unpredictable matchups
- **Persistence**: all results route through `js/score-store.js` so the localStorage backend can be swapped for wallet-linked storage in one file

## Source assets (not committed)

The 5 GB of original 2048×2048 PNGs and the 247 MB raw video live outside the repo
(in the parent `Bepe Love generated/` directory). They are not committed because
they exceed reasonable repo size — they're regenerated on demand via the build
scripts and ultimately distributed via IPFS at mint time.

## License

Art and brand: © Bepe Love. Code: MIT.
