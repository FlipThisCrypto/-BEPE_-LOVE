"""Resize 2,222 source PNGs into web-sized webp variants.

- thumb: 240x240, q=78 (gallery / leaderboard / hand cards)
- card:  640x640, q=82 (hero, focused detail, battle screen)

Originals stay outside the repo. Skips files that already exist so reruns are fast.
"""
from __future__ import annotations

import sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT.parent / "Bepe Love generated" / "images"
THUMB = ROOT / "images" / "thumb"
CARD = ROOT / "images" / "card"

VARIANTS = [
    (THUMB, 240, 78),
    (CARD,  640, 82),
]

def process_one(src: Path) -> str:
    out_name = src.stem + ".webp"
    actions = []
    with Image.open(src) as im:
        im = im.convert("RGB")
        for out_dir, size, quality in VARIANTS:
            dst = out_dir / out_name
            if dst.exists():
                continue
            resized = im.resize((size, size), Image.LANCZOS)
            resized.save(dst, "WEBP", quality=quality, method=6)
            actions.append(out_dir.name)
    return f"{src.name}: {','.join(actions) if actions else 'skip'}"

def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"Source images not found at {SRC}")
    for d, _, _ in VARIANTS:
        d.mkdir(parents=True, exist_ok=True)
    files = sorted(SRC.glob("*.png"))
    print(f"Processing {len(files)} source images...")
    done = 0
    skipped = 0
    written = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(process_one, f) for f in files]
        for fut in as_completed(futures):
            res = fut.result()
            done += 1
            if "skip" in res:
                skipped += 1
            else:
                written += 1
            if done % 200 == 0 or done == len(files):
                print(f"  {done}/{len(files)} (written: {written}, skipped: {skipped})")
    print("Done.")

if __name__ == "__main__":
    main()
