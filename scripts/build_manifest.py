"""Build data/nfts.json from CHIP-0015 metadata files.

Reads ../Bepe Love generated/metadata/*.json, emits a thin manifest with
just what the website needs: id, image paths, points, rank, traits, tier.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC_META = ROOT.parent / "Bepe Love generated" / "metadata"
OUT = ROOT / "data" / "nfts.json"

# Tier bands by rarity_rank (1 = rarest). Names: Tang Gang / Wizard themed.
TIERS = [
    ("Tang Lord",  1,    22),   # mythic
    ("Tang Mage",  23,   222),  # legendary
    ("Wizard",     223,  666),  # epic
    ("Apprentice", 667,  1500), # rare
    ("Pleb",       1501, 2222), # common
]

# Background trait → element mapping for the card game.
# Buckets the 18 backgrounds into 5 elements with rock-paper-scissors style matchups.
ELEMENT_BY_BG = {
    "Bullflare Orange":      "Fire",
    "Gooey Spellfield Orange": "Fire",
    "Arcade Orange":         "Fire",
    "Dennis Voltage Blue":   "Water",
    "SpaceScan Spell Blue":  "Water",
    "Conlive Aqua Signal":   "Water",
    "Taylored Garden Green": "Nature",
    "MintGarden Glow":       "Nature",
    "Sandy Shore Blush":     "Light",
    "Gilded Talk Gold":      "Light",
    "Haze Violet":           "Arcane",
    "Abandon Alley Gray":    "Arcane",
}

def tier_for_rank(rank: int) -> str:
    for name, lo, hi in TIERS:
        if lo <= rank <= hi:
            return name
    return "Pleb"

def attr_dict(attrs: list[dict]) -> dict[str, str]:
    return {a["trait_type"]: a["value"] for a in attrs}

def main() -> None:
    files = sorted(SRC_META.glob("*.json"))
    if not files:
        raise SystemExit(f"No metadata found in {SRC_META}")
    out = []
    for fp in files:
        m = json.loads(fp.read_text(encoding="utf-8"))
        a = attr_dict(m["attributes"])
        rank = int(a["rarity_rank"])
        points = int(a["points"])
        token = int(m["data"]["identifier"]["value"])
        token_str = f"{token:04d}"
        bg = a.get("background", "")
        out.append({
            "id": token,
            "name": m["name"],
            "thumb": f"images/thumb/{token_str}.webp",
            "card":  f"images/card/{token_str}.webp",
            "points": points,
            "rank": rank,
            "tier": tier_for_rank(rank),
            "element": ELEMENT_BY_BG.get(bg, "Arcane"),
            "traits": {
                "background": bg,
                "face":       a.get("face", ""),
                "eyes":       a.get("eyes", ""),
                "mouth":      a.get("mouth", ""),
                "jacket":     a.get("jacket", ""),
                "patch":      a.get("patch", ""),
                "accessory":  a.get("accessory", ""),
            },
        })
    out.sort(key=lambda r: r["id"])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {len(out)} NFTs to {OUT.relative_to(ROOT)}")

    # Also dump a tiny stats summary for the landing page.
    stats = {
        "count": len(out),
        "max_points": max(r["points"] for r in out),
        "min_points": min(r["points"] for r in out),
        "avg_points": round(sum(r["points"] for r in out) / len(out), 1),
        "tier_counts": {name: sum(1 for r in out if r["tier"] == name) for name, _, _ in TIERS},
        "element_counts": {},
    }
    for r in out:
        stats["element_counts"][r["element"]] = stats["element_counts"].get(r["element"], 0) + 1
    stats_path = ROOT / "data" / "stats.json"
    stats_path.write_text(json.dumps(stats, indent=2), encoding="utf-8")
    print(f"Wrote stats to {stats_path.relative_to(ROOT)}")

if __name__ == "__main__":
    main()
