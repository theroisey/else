#!/usr/bin/env python3
"""Regenerate mobile PNGs from the original artwork; requires Pillow."""
from pathlib import Path

from PIL import Image, ImageFilter


FRONTEND = Path(__file__).resolve().parents[1]
OUTPUTS = (
    (152, "assets/apple-touch-icon-152.png"),
    (167, "assets/apple-touch-icon-167.png"),
    (180, "apple-touch-icon.png"),
    (192, "assets/android-chrome-192.png"),
    (512, "assets/android-chrome-512.png"),
)


def main():
    with Image.open(FRONTEND / "artwork/else-app-icon.png") as source:
        if source.size != (2048, 2048):
            raise ValueError("Expected the original 2048×2048 app artwork")
        master = source.convert("RGBA")
        for size, relative in OUTPUTS:
            # Resize directly from the master, then restore fine-edge contrast.
            icon = master.resize((size, size), Image.Resampling.LANCZOS)
            icon = icon.filter(ImageFilter.UnsharpMask(radius=0.5, percent=100, threshold=2))
            icon.save(FRONTEND / "public" / relative, optimize=True, compress_level=9)
            print(f"Prepared {relative} ({size}×{size})")


if __name__ == "__main__":
    main()
