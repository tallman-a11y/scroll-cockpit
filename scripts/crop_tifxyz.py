#!/usr/bin/env python3
"""Crop a segment's tifxyz (and optional layer images) by a 3D volume chunk.

Finds every flattened region whose 3D coordinates fall inside the chunk
(multi-wrap aware), then writes one folder per wrap patch containing cropped
x/y/z.tif (+ any --layers images cropped to the same window) and a meta.json
with both coordinate frames. This is the batch/CLI counterpart of the
Cockpit's in-browser chunk query.

Usage:
  python crop_tifxyz.py --segment DIR --bbox x0 y0 z0 x1 y1 z1 --out OUTDIR \
      [--layers surface.tif ink.png ...] [--min-pixels 200]
"""
import argparse
import json
import os

import numpy as np
import tifffile
from PIL import Image

Image.MAX_IMAGE_PIXELS = None


def components(mask: np.ndarray, min_px: int):
    from collections import deque

    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    out = []
    for sy in range(h):
        for sx in range(w):
            if not mask[sy, sx] or seen[sy, sx]:
                continue
            q = deque([(sy, sx)])
            seen[sy, sx] = True
            px = []
            while q:
                y, x = q.popleft()
                px.append((y, x))
                for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        q.append((ny, nx))
            if len(px) < min_px:
                continue
            ys = [p[0] for p in px]
            xs = [p[1] for p in px]
            out.append((min(ys), min(xs), max(ys) + 1, max(xs) + 1, len(px)))
    out.sort(key=lambda r: -r[4])
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--segment", required=True, help="folder containing x.tif/y.tif/z.tif")
    ap.add_argument("--bbox", nargs=6, type=float, required=True, metavar=("x0", "y0", "z0", "x1", "y1", "z1"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--layers", nargs="*", default=[], help="extra images to crop (full-res, any scale)")
    ap.add_argument("--min-pixels", type=int, default=200)
    ap.add_argument("--pad", type=int, default=8, help="padding in tifxyz px around each patch")
    args = ap.parse_args()

    tx = tifffile.imread(os.path.join(args.segment, "x.tif"))
    ty = tifffile.imread(os.path.join(args.segment, "y.tif"))
    tz = tifffile.imread(os.path.join(args.segment, "z.tif"))
    b = args.bbox
    mn = [min(b[0], b[3]), min(b[1], b[4]), min(b[2], b[5])]
    mx = [max(b[0], b[3]), max(b[1], b[4]), max(b[2], b[5])]
    mask = (
        (tx >= mn[0]) & (tx <= mx[0])
        & (ty >= mn[1]) & (ty <= mx[1])
        & (tz >= mn[2]) & (tz <= mx[2])
        & (tz > 0)
    )
    print(f"mask: {int(mask.sum()):,} tifxyz px inside chunk")
    patches = components(mask, args.min_pixels)
    print(f"{len(patches)} wrap patches")

    layers = []
    for pth in args.layers:
        img = np.asarray(Image.open(pth)) if not pth.endswith(".tif") else tifffile.imread(pth)
        layers.append((os.path.basename(pth), img))

    TH, TW = tx.shape
    os.makedirs(args.out, exist_ok=True)
    for i, (y0, x0, y1, x1, npx) in enumerate(patches, 1):
        y0 = max(0, y0 - args.pad); x0 = max(0, x0 - args.pad)
        y1 = min(TH, y1 + args.pad); x1 = min(TW, x1 + args.pad)
        d = os.path.join(args.out, f"wrap_{i:02d}")
        os.makedirs(d, exist_ok=True)
        tifffile.imwrite(os.path.join(d, "x.tif"), tx[y0:y1, x0:x1])
        tifffile.imwrite(os.path.join(d, "y.tif"), ty[y0:y1, x0:x1])
        tifffile.imwrite(os.path.join(d, "z.tif"), tz[y0:y1, x0:x1])
        tifffile.imwrite(os.path.join(d, "chunk_mask.tif"), mask[y0:y1, x0:x1].astype(np.uint8) * 255)
        for name, img in layers:
            ly0, lx0 = int(y0 / TH * img.shape[0]), int(x0 / TW * img.shape[1])
            ly1, lx1 = int(y1 / TH * img.shape[0]), int(x1 / TW * img.shape[1])
            out_img = img[ly0:ly1, lx0:lx1]
            tifffile.imwrite(os.path.join(d, f"crop_{name}.tif"), out_img)
        sub = mask[y0:y1, x0:x1]
        pts = [tx[y0:y1, x0:x1][sub], ty[y0:y1, x0:x1][sub], tz[y0:y1, x0:x1][sub]]
        with open(os.path.join(d, "meta.json"), "w") as f:
            json.dump(
                {
                    "wrap": i,
                    "pixels_in_chunk": int(npx),
                    "tifxyz_window_yxhw": [int(y0), int(x0), int(y1 - y0), int(x1 - x0)],
                    "query_bbox_xyz": [mn, mx],
                    "patch_volume_bbox_xyz": [
                        [round(float(p.min()), 1) for p in pts],
                        [round(float(p.max()), 1) for p in pts],
                    ],
                },
                f,
                indent=2,
            )
        print(f"wrap_{i:02d}: tifxyz window ({x0},{y0}) {x1-x0}x{y1-y0}, {npx:,} px in chunk")


if __name__ == "__main__":
    main()
