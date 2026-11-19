#!/usr/bin/env python3
"""Turn a light mark on a dark background (a logo) into a lit, character-drawn relief for the profile card.

Method after JIN2 (@jin_22ee): light the shape like a 3D object, outline its edges with | - _ / \\,
fill it with letters that get denser where it is brighter, and add a few spaced sparkles.
This is an independent implementation for one still picture (no animation, no particles).

Run once, offline; the card generator only reads the JSON it writes, so CI needs no Python.

    python scripts/make_portrait.py SOURCE --region 0,0,460,195 --out assets/portrait.json
"""
import argparse
import json
import math
import sys

import numpy as np
from PIL import Image, ImageFilter

# Letter pools from dark to bright (the method's suggested pools).
POOLS = [".:;il!", "rcvxz=+t", "aeosun{}<>", "8B#$&%@Q"]
CELL_ASPECT = 1.6  # character cell height / width on the card (8.4 px / 5.25 px)
SS = 4  # supersampling: pixels per cell side when lighting
WHITE = 9  # level reserved for sparkle centres


def edge_glyph(dx, dy):
    """Outline character for a cell whose empty neighbours lie in direction (dx, dy); y grows downwards."""
    if dx == 0 and dy == 0:
        return "|"
    ang = math.degrees(math.atan2(-dy, dx)) % 180  # direction of the edge normal, folded to 0..180
    if ang < 22.5 or ang >= 157.5:
        return "|"  # outside is left or right
    if 67.5 <= ang < 112.5:
        return "-" if dy < 0 else "_"  # outside is above or below
    # diagonal: outside up-right or down-left -> "\", up-left or down-right -> "/"
    return "\\" if (dx > 0) == (dy < 0) else "/"


def cell_hash(r, c, salt=0):
    """Well-mixed integer hash, so letter choices never repeat in a visible pattern along a row."""
    h = (r * 374761393 + c * 668265263 + salt * 2246822519) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    h = ((h ^ (h >> 16)) * 2654435761) & 0xFFFFFFFF
    return h ^ (h >> 15)


def outside_distance(inside):
    """Cell steps from each empty cell to the nearest filled cell (8-neighbour dilation), capped at 8."""
    rows, cols = inside.shape
    d = np.full(inside.shape, 99, np.int32)
    d[inside] = 0
    cur = inside.copy()
    for step in range(1, 9):
        p = np.pad(cur, 1)
        grown = np.zeros_like(cur)
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                grown |= p[1 + dr:1 + dr + rows, 1 + dc:1 + dc + cols]
        d[grown & ~cur] = step
        cur = grown
    return d


def load_crop(path, region, threshold):
    img = Image.open(path).convert("L")
    if region:
        img = img.crop(region)
    a = np.asarray(img, dtype=np.float32) / 255.0
    ys, xs = np.nonzero(a > threshold)
    if xs.size == 0:
        raise ValueError(f"no pixels brighter than {threshold} in that region; check --region and --threshold")
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    pad = int(0.08 * max(x1 - x0, y1 - y0))
    box = (max(0, x0 - pad), max(0, y0 - pad), min(img.width, x1 + pad), min(img.height, y1 + pad))
    return img.crop(box)


def inside_distance(mask):
    """Steps of 4-neighbour erosion each pixel survives: a cheap distance-to-edge inside the mask."""
    m = np.pad(mask, 1)
    d = np.zeros(m.shape, np.float32)
    cur = m.copy()
    while cur.any():
        d += cur
        cur = cur & np.roll(cur, 1, 0) & np.roll(cur, -1, 0) & np.roll(cur, 1, 1) & np.roll(cur, -1, 1)
    return d[1:-1, 1:-1]


def light(cover):
    """Brightness of a rounded relief built on the mask: ambient + key light + rim light + sharp highlight."""
    mask = cover > 0.5
    d = inside_distance(mask)
    radius = max(1.0, 0.75 * d.max())
    t = np.clip(d / radius, 0, 1)
    height = np.sqrt(1 - (1 - t) ** 2)  # quarter-circle bevel, flat on top
    height = np.asarray(Image.fromarray((height * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2)), np.float32) / 255
    gy, gx = np.gradient(height)
    k = radius * 0.9
    n = np.dstack([-gx * k, -gy * k, np.ones_like(height)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)

    def unit(v):
        v = np.array(v, np.float32)
        return v / np.linalg.norm(v)

    key, rim, view = unit([-0.55, -0.7, 0.55]), unit([0.75, 0.45, 0.3]), unit([0, 0, 1])
    half = unit(key + view)
    diffuse = np.clip(n @ key, 0, None)
    rim_l = np.clip(n @ rim, 0, None)
    spec = np.clip(n @ half, 0, None) ** 48
    b = 0.32 + 0.5 * diffuse + 0.22 * rim_l + 0.85 * spec
    return np.clip(b / 1.3, 0, 1)


def portrait(path, region=None, cols=54, threshold=0.5, sparkles=3, dust=0.012, field=0.16, seed=7):
    crop = load_crop(path, region, threshold)
    rows = max(4, round(cols * (crop.height / crop.width) / CELL_ASPECT))
    hi = crop.resize((cols * SS, rows * SS), Image.LANCZOS)
    cover = np.asarray(hi, np.float32) / 255.0
    bright = light(cover) * (cover > 0.5)

    cov = cover.reshape(rows, SS, cols, SS).mean(axis=(1, 3))
    inside = cov >= 0.45
    lit = bright.reshape(rows, SS, cols, SS).sum(axis=(1, 3)) / np.maximum((cover > 0.5).reshape(rows, SS, cols, SS).sum(axis=(1, 3)), 1)

    chars = [[" "] * cols for _ in range(rows)]
    levels = [[" "] * cols for _ in range(rows)]
    filled = lambda r, c: 0 <= r < rows and 0 <= c < cols and inside[r, c]

    for r in range(rows):
        for c in range(cols):
            if not inside[r, c]:
                continue
            b = float(lit[r, c])
            empties = [(dc, dr) for dr in (-1, 0, 1) for dc in (-1, 0, 1) if (dr or dc) and not filled(r + dr, c + dc)]
            four = any(not filled(r + dr, c + dc) for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)))
            if four:
                chars[r][c] = edge_glyph(sum(e[0] for e in empties), sum(e[1] for e in empties))
                levels[r][c] = str(min(8, max(6, int(b * 8.99))))
            else:
                pool = POOLS[min(3, int(b * 4))]
                chars[r][c] = pool[cell_hash(r, c) % len(pool)]
                levels[r][c] = str(min(8, max(1, int(b * 8.99))))

    # Sparkles: the brightest inside cells, spaced apart, with short four-pointed rays.
    order = sorted(((float(lit[r, c]), r, c) for r in range(rows) for c in range(cols) if inside[r, c]), reverse=True)
    picked = []
    for _, r, c in order:
        if len(picked) >= sparkles:
            break
        if all(abs(r - pr) + abs(c - pc) >= max(8, cols // 5) for pr, pc in picked):
            picked.append((r, c))
    for r, c in picked:
        chars[r][c], levels[r][c] = "*", str(WHITE)
        for dc, ch, lv in ((-1, "-", 8), (1, "-", 8), (-2, "-", 6), (2, "-", 6)):
            if 0 <= c + dc < cols:
                chars[r][c + dc], levels[r][c + dc] = ch, str(lv)
        for dr in (-1, 1):
            if 0 <= r + dr < rows:
                chars[r + dr][c], levels[r + dr][c] = "|", "8"

    # Background: a dim field of letters that thickens into a halo near the mark, so the lit shape
    # rises out of a textured surface instead of floating in empty space. Deterministic.
    rng = np.random.default_rng(seed)
    near = outside_distance(inside)
    for r in range(rows):
        for c in range(cols):
            if chars[r][c] != " ":
                continue
            d = near[r, c]
            halo = 0.55 if d <= 1 else 0.35 if d <= 3 else field
            if rng.random() < halo:
                pool = POOLS[1] if d <= 1 else POOLS[0]
                chars[r][c] = pool[cell_hash(r, c, 1) % len(pool)]
                levels[r][c] = "2" if d <= 2 else "1"
            elif rng.random() < dust:
                chars[r][c], levels[r][c] = (".", "3") if rng.random() < 0.7 else ("+", "4")

    return {
        "credit": "after JIN2 (@jin_22ee)",
        "cols": cols,
        "rows": rows,
        "chars": ["".join(row) for row in chars],
        "levels": ["".join(row) for row in levels],
    }


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("source")
    p.add_argument("--region", help="x0,y0,x1,y1 crop of the source before finding the mark")
    p.add_argument("--cols", type=int, default=54)
    p.add_argument("--threshold", type=float, default=0.5)
    p.add_argument("--out", default="assets/portrait.json")
    a = p.parse_args(argv)
    region = tuple(int(v) for v in a.region.split(",")) if a.region else None
    try:
        data = portrait(a.source, region, a.cols, a.threshold)
    except (OSError, ValueError) as err:
        print(f"make_portrait failed: {err}", file=sys.stderr)
        return 1
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=0)
    print(f"wrote {a.out}: {data['cols']}x{data['rows']} cells")
    return 0


if __name__ == "__main__":
    sys.exit(main())
