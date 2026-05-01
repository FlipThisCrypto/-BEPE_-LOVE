"""Generate site/og-image.png — the 1200x630 social-share image used by
Open Graph (Facebook, Discord, LinkedIn) and Twitter Cards (summary_large_image).

Picks the rarest 6 Bepes from data/nfts.json, composites them in a row
with brand text + tagline.
"""
from __future__ import annotations

import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "nfts.json"
CARD_DIR = ROOT / "images" / "card"
OUT = ROOT / "og-image.png"

W, H = 1200, 630

# Brand palette
DEEP = (6, 4, 15)
ORANGE = (255, 122, 0)
HOT = (255, 42, 163)
GOLD = (255, 208, 106)
WHITE = (255, 255, 255)
INK_2 = (170, 170, 200)


def load_font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    """Try to load a nice font; fall back to default if not available."""
    candidates_bold = ["arialbd.ttf", "Arial Bold.ttf", "calibrib.ttf", "segoeuib.ttf"]
    candidates = ["arial.ttf", "Arial.ttf", "calibri.ttf", "segoeui.ttf"]
    for name in (candidates_bold if bold else candidates):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def vertical_gradient(w: int, h: int, top_rgb, bot_rgb) -> Image.Image:
    img = Image.new("RGB", (w, h), top_rgb)
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        r = int(top_rgb[0] + (bot_rgb[0] - top_rgb[0]) * t)
        g = int(top_rgb[1] + (bot_rgb[1] - top_rgb[1]) * t)
        b = int(top_rgb[2] + (bot_rgb[2] - top_rgb[2]) * t)
        for x in range(w):
            px[x, y] = (r, g, b)
    return img


def radial_glow(w: int, h: int, cx: int, cy: int, color, radius: int, alpha: int = 180) -> Image.Image:
    """Simple radial glow as an overlay layer (RGBA)."""
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    for r in range(radius, 0, -8):
        a = int(alpha * (1 - r / radius) ** 2)
        draw.ellipse(
            [cx - r, cy - r, cx + r, cy + r],
            fill=(color[0], color[1], color[2], a),
        )
    return layer.filter(ImageFilter.GaussianBlur(8))


def round_corners(im: Image.Image, radius: int) -> Image.Image:
    """Apply rounded corners by masking alpha."""
    mask = Image.new("L", im.size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([0, 0, im.size[0], im.size[1]], radius=radius, fill=255)
    out = im.convert("RGBA")
    out.putalpha(mask)
    return out


def paste_card(base: Image.Image, card_path: Path, x: int, y: int, size: int) -> None:
    """Paste a card image with rounded corners + drop shadow."""
    if not card_path.exists():
        return
    im = Image.open(card_path).convert("RGB").resize((size, size), Image.LANCZOS)
    im = round_corners(im, radius=int(size * 0.14))

    # Drop shadow
    shadow = Image.new("RGBA", (size + 40, size + 40), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shadow)
    sdraw.rounded_rectangle(
        [20, 28, 20 + size, 28 + size],
        radius=int(size * 0.14), fill=(0, 0, 0, 200),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(12))
    base.alpha_composite(shadow, (x - 20, y - 20))
    base.alpha_composite(im, (x, y))


def main() -> None:
    if not DATA.exists():
        raise SystemExit(f"Manifest not found: {DATA}")
    with DATA.open(encoding="utf-8") as f:
        nfts = json.load(f)

    # Top 6 by points (rarest carry highest visual weight)
    top = sorted(nfts, key=lambda n: -n["points"])[:6]

    # Background: dark with two glows (orange + magenta) reminiscent of the site hero.
    bg = vertical_gradient(W, H, (10, 7, 25), DEEP).convert("RGBA")
    bg.alpha_composite(radial_glow(W, H, 200, 140, ORANGE, 320, 200))
    bg.alpha_composite(radial_glow(W, H, 1000, 480, HOT, 320, 180))

    draw = ImageDraw.Draw(bg)

    # Subtle grid lines (atmospheric)
    for x in range(0, W, 36):
        draw.line([(x, 0), (x, H)], fill=(255, 255, 255, 8))
    for y in range(0, H, 36):
        draw.line([(0, y), (W, y)], fill=(255, 255, 255, 8))

    # Brand mark (heart in rounded gradient square, top-left)
    bm_size = 64
    bm = Image.new("RGBA", (bm_size, bm_size), (0, 0, 0, 0))
    bm_draw = ImageDraw.Draw(bm)
    bm_draw.rounded_rectangle([0, 0, bm_size, bm_size], radius=18, fill=ORANGE + (255,))
    bm_draw.rounded_rectangle([0, 0, bm_size, bm_size], radius=18, outline=HOT + (180,), width=4)
    heart_font = load_font(38, bold=True)
    bx0, by0, bx1, by1 = bm_draw.textbbox((0, 0), "♥", font=heart_font)
    bm_draw.text(
        ((bm_size - (bx1 - bx0)) // 2 - bx0, (bm_size - (by1 - by0)) // 2 - by0 - 4),
        "♥", fill=(20, 5, 12, 255), font=heart_font,
    )
    bg.alpha_composite(bm, (60, 56))

    # Brand text "$BEPE $LOVE"
    brand_font = load_font(28, bold=True)
    draw.text((144, 64), "$BEPE $LOVE", fill=WHITE, font=brand_font)
    sub_font = load_font(16, bold=False)
    draw.text((144, 102), "WIZARD TOKEN ENERGY · TANG GANG · CHIA", fill=INK_2, font=sub_font)

    # Top-right corner: collection tag
    tag_font = load_font(16, bold=True)
    tag_text = "2,222 NFTs ON CHIA"
    tx0, ty0, tx1, ty1 = draw.textbbox((0, 0), tag_text, font=tag_font)
    draw.rounded_rectangle(
        [W - (tx1 - tx0) - 100, 70, W - 60, 110],
        radius=20, outline=ORANGE + (200,), width=2, fill=(255, 122, 0, 30),
    )
    draw.text((W - (tx1 - tx0) - 80, 78), tag_text, fill=GOLD, font=tag_font)

    # Headline — domain-style "Bepe.Love" on one line, measured so segments
    # don't overlap. Bepe in white, the dot in orange as a brand accent,
    # Love in gold.
    h1_font = load_font(110, bold=True)
    parts = [("Bepe", WHITE), (".", ORANGE), ("Love", GOLD)]
    cursor_x = 60
    headline_y = 168
    for text, color in parts:
        draw.text((cursor_x, headline_y), text, fill=color, font=h1_font)
        bbox = draw.textbbox((cursor_x, headline_y), text, font=h1_font)
        cursor_x = bbox[2]  # right edge becomes left edge of next part

    # Tagline
    tag2_font = load_font(22, bold=False)
    draw.text(
        (60, 312),
        "Mint a random Bepe. Stack a hand. Run the auto-battler.",
        fill=INK_2, font=tag2_font,
    )

    # Six rare Bepes in a row, near the bottom
    card_size = 140
    gap = 20
    row_w = card_size * 6 + gap * 5
    row_x0 = (W - row_w) // 2
    row_y = H - card_size - 80
    for i, nft in enumerate(top):
        cp = ROOT / nft["card"]
        x = row_x0 + i * (card_size + gap)
        paste_card(bg, cp, x, row_y, card_size)

    # Bottom strip with price
    price_font = load_font(28, bold=True)
    price_text = "MINT A RANDOM BEPE — 2 XCH"
    px0, py0, px1, py1 = draw.textbbox((0, 0), price_text, font=price_font)
    draw.text(
        ((W - (px1 - px0)) // 2, H - 50),
        price_text, fill=ORANGE, font=price_font,
    )

    # Save
    bg.convert("RGB").save(OUT, "PNG", optimize=True)
    print(f"Wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
