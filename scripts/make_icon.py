#!/usr/bin/env python3
"""Generate media/icon.png — the official Command Code symbol with a PROVIDER banner.

The mark is Command Code's trademark. It is used here, unmodified, only to
identify which service the models come from; the banner is additive. See the
"Icon and trademark" section of the README.

The mark is rasterised from the vendor's own symbol.svg (sourced from
https://commandcode.ai/brand) with `rsvg-convert`, then composited with a
caption strip. Nothing is re-drawn by hand: the previous version transcribed
the SVG paths by hand and produced a broken mark.

Requires: rsvg-convert, Pillow.

Usage:  python3 scripts/make_icon.py
"""
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SIZE = 128
MARK_H = 96          # height reserved for the official mark
BANNER_TOP = MARK_H
BANNER_H = SIZE - BANNER_TOP  # 32px
CAPTION = "PROVIDER"
TEXT = (255, 255, 255)
PLATE = (0, 0, 0)

REPO = Path(__file__).resolve().parent.parent
ICON = REPO / "media" / "icon.png"
SYMBOL_URL = (
    "https://raw.githubusercontent.com/CommandCodeAI/command-code"
    "/refs/heads/main/.github/commandcode/symbols/symbol.svg"
)
SYMBOL_CACHE = Path(__file__).resolve().parent / "symbol.svg"

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def load_symbol() -> Path:
    """Rasterise the vendor mark. Uses a vendored copy if one is present."""
    src = SYMBOL_CACHE
    if not src.exists():
        sys.exit(
            f"Missing {src}.\n"
            f"Download the official mark from {SYMBOL_URL} and save it there,\n"
            "so the icon is built from the vendor's own artwork rather than a hand copy."
        )
    return src


def build() -> None:
    symbol = load_symbol()

    with tempfile.TemporaryDirectory() as td:
        big = Path(td) / "symbol.png"
        subprocess.run(
            ["rsvg-convert", "-w", "1024", "-h", "1024", str(symbol), "-o", str(big)],
            check=True,
        )
        mark = Image.open(big).convert("RGBA")
        # Trim the transparent margin the viewBox leaves, then scale to fit.
        bbox = mark.getbbox()
        if bbox:
            mark = mark.crop(bbox)
        scale = min(SIZE / mark.width, MARK_H / mark.height)
        mark = mark.resize(
            (max(1, round(mark.width * scale)), max(1, round(mark.height * scale))),
            Image.LANCZOS,
        )

        canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        canvas.alpha_composite(mark, ((SIZE - mark.width) // 2, (MARK_H - mark.height) // 2))

        draw = ImageDraw.Draw(canvas)

        # Caption plate, full width so the word never sits on a transparent edge.
        draw.rectangle([0, BANNER_TOP, SIZE, SIZE], fill=PLATE + (255,))

        font = None
        for path in FONT_CANDIDATES:
            if Path(path).exists():
                for size in range(20, 5, -1):
                    font = ImageFont.truetype(path, size)
                    if draw.textlength(CAPTION, font=font) <= SIZE - 10:
                        break
                break
        if font is None:
            sys.exit("No usable font found for the caption.")

        box = draw.textbbox((0, 0), CAPTION, font=font)
        w, h = box[2] - box[0], box[3] - box[1]
        draw.text(
            ((SIZE - w) / 2 - box[0], BANNER_TOP + (BANNER_H - h) / 2 - box[1]),
            CAPTION,
            font=font,
            fill=TEXT + (255,),
        )

        ICON.parent.mkdir(parents=True, exist_ok=True)
        canvas.save(ICON, optimize=True)

    with Image.open(ICON) as check:
        assert check.size == (SIZE, SIZE), f"icon is {check.size}, expected {(SIZE, SIZE)}"
    print(f"wrote {ICON} ({ICON.stat().st_size} bytes, {SIZE}x{SIZE})")


if __name__ == "__main__":
    build()
