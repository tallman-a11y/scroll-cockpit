#!/usr/bin/env python3
"""Difficult-chunk scorer: curvature + compression from a segment mesh.

Per the Vesuvius Challenge team, surface-model failures concentrate where the
papyrus is "curvature + compression" — but no ranked list of those regions
exists. This script computes one from a segment's public .obj mesh:

  compression = |log(3D face area / flattened UV area)|   (parameterization distortion)
  curvature   = mean dihedral angle with adjacent faces    (local bending)

Both are rasterized onto the segment's flattened coordinate grid, combined,
and emitted as:
  - difficulty_l3.png   heatmap aligned to prediction pyramid level 3 (8x world)
  - difficult_chunks.json / .csv   top-N hardest chunks with flattened bbox,
    3D volume bbox (zyx), and scores — the "annotated chunks needed here" list.

Usage:
  python compute_difficulty.py --obj 20231016151002.obj \
      --width 51380 --height 32249 --out OUTDIR [--chunk 1024] [--top 50]
"""
import argparse
import csv
import json
import os

import numpy as np
import trimesh
from PIL import Image


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--obj", required=True)
    ap.add_argument("--width", type=int, required=True, help="flattened full-res width")
    ap.add_argument("--height", type=int, required=True, help="flattened full-res height")
    ap.add_argument("--out", required=True)
    ap.add_argument("--chunk", type=int, default=1024, help="chunk size, full-res px")
    ap.add_argument("--top", type=int, default=50)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    print("loading mesh…")
    mesh = trimesh.load(args.obj, process=False)
    uv = np.asarray(mesh.visual.uv)  # per-vertex, normalized 0..1
    faces = np.asarray(mesh.faces)
    verts = np.asarray(mesh.vertices)  # scroll volume coords (x, y, z), voxel units
    print(f"verts {len(verts):,} · faces {len(faces):,}")

    # per-face UV centroid in full-res flattened px (u -> x, v -> y)
    fuv = uv[faces].mean(axis=1)
    fx = fuv[:, 0] * args.width
    fy = (1.0 - fuv[:, 1]) * args.height  # obj v runs bottom-up

    # compression: |log(area3d / areaUV_px)|
    area3d = mesh.area_faces
    uv_px = uv.copy()
    uv_px[:, 0] *= args.width
    uv_px[:, 1] *= args.height
    tri = uv_px[faces]
    e1 = tri[:, 1] - tri[:, 0]
    e2 = tri[:, 2] - tri[:, 0]
    area_uv = 0.5 * np.abs(e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0])
    ok = (area_uv > 1e-9) & (area3d > 1e-9)
    compression = np.zeros(len(faces), np.float32)
    compression[ok] = np.abs(np.log(area3d[ok] / area_uv[ok]))

    # curvature: mean dihedral angle per face
    print("computing dihedral curvature…")
    adj = mesh.face_adjacency
    ang = mesh.face_adjacency_angles
    curv_sum = np.zeros(len(faces), np.float64)
    curv_cnt = np.zeros(len(faces), np.float64)
    np.add.at(curv_sum, adj[:, 0], ang)
    np.add.at(curv_sum, adj[:, 1], ang)
    np.add.at(curv_cnt, adj[:, 0], 1)
    np.add.at(curv_cnt, adj[:, 1], 1)
    curvature = (curv_sum / np.maximum(curv_cnt, 1)).astype(np.float32)

    # rasterize per-face scores to level-6 grid (full-res / 64 ≈ triangle scale)
    G = 64
    gh, gw = args.height // G + 1, args.width // G + 1
    gx = np.clip((fx / G).astype(int), 0, gw - 1)
    gy = np.clip((fy / G).astype(int), 0, gh - 1)
    flat = gy * gw + gx

    def grid_mean(vals: np.ndarray) -> np.ndarray:
        s = np.bincount(flat, weights=vals, minlength=gh * gw)
        c = np.bincount(flat, minlength=gh * gw)
        g = np.where(c > 0, s / np.maximum(c, 1), np.nan)
        return g.reshape(gh, gw), c.reshape(gh, gw) > 0

    g_comp, mask = grid_mean(compression)
    g_curv, _ = grid_mean(curvature)

    def norm(g: np.ndarray) -> np.ndarray:
        v = g[mask]
        lo, hi = np.nanpercentile(v, [10, 95])
        return np.clip((g - lo) / max(hi - lo, 1e-9), 0, 1)

    n_comp = norm(g_comp)
    n_curv = norm(g_curv)
    difficulty = np.fmax(n_comp, n_curv)
    difficulty = np.where(mask, difficulty, 0)

    # heatmap PNG: magenta = difficult, transparent elsewhere.
    # Scored at level 6; upscaled 8x so the saved PNG aligns to pyramid level 3.
    heat = np.zeros((gh, gw, 4), np.uint8)
    d8 = (np.nan_to_num(difficulty) * 255).astype(np.uint8)
    heat[..., 0] = np.where(mask, d8, 0)
    heat[..., 1] = 32
    heat[..., 2] = np.where(mask, d8, 0)
    heat[..., 3] = np.where(mask, (np.nan_to_num(difficulty) * 170).astype(np.uint8), 0)
    im = Image.fromarray(heat).resize((gw * 8, gh * 8), Image.BILINEAR)
    im.save(os.path.join(args.out, "difficulty_l3.png"))

    # chunk ranking
    print("ranking chunks…")
    cs = max(args.chunk // G, 1)  # chunk size in grid cells
    rows = []
    for cy in range(0, gh - cs + 1, cs):
        for cx in range(0, gw - cs + 1, cs):
            m = mask[cy : cy + cs, cx : cx + cs]
            if m.mean() < 0.6:
                continue
            d = np.nanmean(difficulty[cy : cy + cs, cx : cx + cs])
            rows.append((float(d), cy, cx))
    rows.sort(reverse=True)
    top = rows[: args.top]

    chunks = []
    for rank, (score, cy, cx) in enumerate(top, 1):
        y0f, x0f = cy * G, cx * G  # grid cell -> full-res px
        # faces whose centroid falls in this chunk -> 3D bbox
        sel = (
            (fx >= x0f) & (fx < x0f + args.chunk) & (fy >= y0f) & (fy < y0f + args.chunk)
        )
        v3 = verts[np.unique(faces[sel].ravel())] if sel.any() else np.zeros((1, 3))
        chunks.append(
            {
                "rank": rank,
                "difficulty": round(score, 4),
                "flattened_bbox_xywh": [int(x0f), int(y0f), args.chunk, args.chunk],
                "volume_bbox_xyz_min": [round(float(c), 1) for c in v3.min(axis=0)],
                "volume_bbox_xyz_max": [round(float(c), 1) for c in v3.max(axis=0)],
            }
        )

    with open(os.path.join(args.out, "difficult_chunks.json"), "w") as f:
        json.dump(
            {
                "segment": os.path.basename(args.obj).replace(".obj", ""),
                "method": "max(norm(|log(area3d/areaUV)|), norm(mean dihedral angle)) per level-3 cell",
                "chunk_px": args.chunk,
                "chunks": chunks,
            },
            f,
            indent=2,
        )
    with open(os.path.join(args.out, "difficult_chunks.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["rank", "difficulty", "flat_x", "flat_y", "size", "vol_min_xyz", "vol_max_xyz"])
        for c in chunks:
            w.writerow(
                [
                    c["rank"],
                    c["difficulty"],
                    c["flattened_bbox_xywh"][0],
                    c["flattened_bbox_xywh"][1],
                    c["flattened_bbox_xywh"][2],
                    " ".join(map(str, c["volume_bbox_xyz_min"])),
                    " ".join(map(str, c["volume_bbox_xyz_max"])),
                ]
            )
    print(f"wrote difficulty_l3.png + difficult_chunks.json/.csv ({len(chunks)} chunks)")


if __name__ == "__main__":
    main()
