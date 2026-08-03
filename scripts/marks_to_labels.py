#!/usr/bin/env python3
"""Convert Scroll Cockpit review marks into koine_machines training labels.

Takes the JSON exported by the Cockpit's review queue and paints label boxes
into COPIES of the segment's inklabels/supervision_mask zarrs:

  verdict "ink":  inklabels[box] = (prediction > thresh) * 255   (confirmed pseudo-label)
  verdict "not":  inklabels[box] = 0                             (negative supervision)
  both:           supervision_mask[box] = 255
  "unsure"/pending: skipped

Labels are written at z=32 (the surface plane — the segment convention) at
level 0, then pyramid levels are max-pool regenerated for the touched boxes.
Originals are never modified; output is a staging folder you can point a
training config's segments_path at.

Usage:
  python marks_to_labels.py --marks cockpit-marks-XXX.json \
      --segment /path/to/w00_20231016151002 \
      --pred /path/to/predictions/w00_20231016151002.tif \
      --out /path/to/staging [--box 256] [--thresh 128]
"""
import argparse
import json
import os
import shutil

import numpy as np
import tifffile
import zarr

Z_SURFACE = 32


def pool2(a: np.ndarray) -> np.ndarray:
    h, w = a.shape
    a = a[: h - (h % 2), : w - (w % 2)]
    return a.reshape(h // 2, 2, w // 2, 2).max(axis=(1, 3))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--marks", required=True)
    ap.add_argument("--segment", required=True, help="segment folder (contains *.zarr)")
    ap.add_argument("--pred", required=True, help="ink prediction TIFF (full res)")
    ap.add_argument("--out", required=True, help="staging output folder")
    ap.add_argument("--box", type=int, default=256, help="label box size, full-res px")
    ap.add_argument("--thresh", type=int, default=128)
    args = ap.parse_args()

    seg_name = os.path.basename(os.path.normpath(args.segment))
    with open(args.marks) as f:
        payload = json.load(f)
    marks = [m for m in payload["marks"] if m["verdict"] in ("ink", "not")]
    if not marks:
        print("no ink/not verdicts in marks file; nothing to export")
        return

    os.makedirs(args.out, exist_ok=True)
    staged = {}
    for kind in ("inklabels", "supervision_mask"):
        src = os.path.join(args.segment, f"{seg_name}_{kind}.zarr")
        dst = os.path.join(args.out, f"{seg_name}_{kind}.zarr")
        if not os.path.exists(dst):
            print(f"copying {kind}…")
            shutil.copytree(src, dst)
        staged[kind] = dst

    print("loading prediction TIFF…")
    pred = tifffile.imread(args.pred)

    ink0 = zarr.open(os.path.join(staged["inklabels"], "0"), mode="r+")
    sup0 = zarr.open(os.path.join(staged["supervision_mask"], "0"), mode="r+")
    _, H, W = ink0.shape
    half = args.box // 2

    boxes = []
    n_ink = n_not = 0
    for m in marks:
        x, y = int(m["x"]), int(m["y"])
        y0, y1 = max(0, y - half), min(H, y + half)
        x0, x1 = max(0, x - half), min(W, x + half)
        if y1 <= y0 or x1 <= x0:
            continue
        if m["verdict"] == "ink":
            p = np.asarray(pred[y0:y1, x0:x1])
            ink0[Z_SURFACE, y0:y1, x0:x1] = ((p > args.thresh) * 255).astype(np.uint8)
            n_ink += 1
        else:
            ink0[Z_SURFACE, y0:y1, x0:x1] = 0
            n_not += 1
        sup0[Z_SURFACE, y0:y1, x0:x1] = 255
        boxes.append((y0, y1, x0, x1))

    # regenerate pyramid levels for touched boxes
    levels = sorted(
        int(d) for d in os.listdir(staged["inklabels"]) if d.isdigit() and int(d) > 0
    )
    for kind in ("inklabels", "supervision_mask"):
        lvl0 = zarr.open(os.path.join(staged[kind], "0"), mode="r")
        for L in levels:
            arr = zarr.open(os.path.join(staged[kind], str(L)), mode="r+")
            zi = Z_SURFACE if arr.shape[0] == lvl0.shape[0] else arr.shape[0] // 2
            for (y0, y1, x0, x1) in boxes:
                a = np.asarray(lvl0[Z_SURFACE, y0:y1, x0:x1])
                for _ in range(L):
                    a = pool2(a)
                ly0, lx0 = y0 >> L, x0 >> L
                if a.size:
                    arr[zi, ly0 : ly0 + a.shape[0], lx0 : lx0 + a.shape[1]] = a

    changed = sum((y1 - y0) * (x1 - x0) for (y0, y1, x0, x1) in boxes)
    print(
        f"exported {n_ink} ink + {n_not} negative boxes "
        f"({changed:,} labeled px at z={Z_SURFACE}) -> {args.out}"
    )
    print("Point a training config's segments_path at a folder containing the")
    print(f"segment volume plus these staged zarrs to train on your judgments.")


if __name__ == "__main__":
    main()
