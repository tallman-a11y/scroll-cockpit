"""Reliability heatmap v2 for a segment's ink predictions.

Score per region = (detrended text-line periodicity) x (sane-coverage window),
computed on overlapping windows and gaussian-smoothed. Red = unreliable,
green = trustworthy, transparent = off-papyrus. Output aligned to prediction
pyramid level 3 (world scale 8x).

Run (WSL): /home/tyler/labenv/bin/python build_reliability.py \
    --pred /mnt/c/.../predictions/w00_20231016151002.tif \
    --surf /mnt/c/.../w00_20231016151002.zarr/3 \
    --out  /mnt/c/.../reliability
"""
import argparse
import os

import numpy as np
import tifffile
import zarr
from PIL import Image

BLOCK_H, BLOCK_W, STRIDE = 512, 384, 128  # level-3 pixels
MIN_PERIOD, MAX_PERIOD = 40, 220


def gaussian_kernel1d(sigma: float) -> np.ndarray:
    r = int(3 * sigma)
    x = np.arange(-r, r + 1, dtype=np.float32)
    k = np.exp(-0.5 * (x / sigma) ** 2)
    return k / k.sum()


def smooth2d(a: np.ndarray, sigma: float) -> np.ndarray:
    k = gaussian_kernel1d(sigma)
    a = np.apply_along_axis(lambda r: np.convolve(r, k, mode="same"), 1, a)
    a = np.apply_along_axis(lambda c: np.convolve(c, k, mode="same"), 0, a)
    return a


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pred", required=True)
    ap.add_argument("--surf", required=True, help="segment surface zarr level 3 path")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    print("Loading prediction (level 3)...")
    pred = tifffile.imread(args.pred)[::8, ::8].astype(np.float32)
    H, W = pred.shape
    print(f"level-3 prediction: {pred.shape}")

    surf = np.asarray(zarr.open(args.surf, mode="r")[32])[:H, :W]
    papyrus = surf > 8
    ink = (pred > 128).astype(np.float32)

    ny = max((H - BLOCK_H) // STRIDE + 1, 1)
    nx = max((W - BLOCK_W) // STRIDE + 1, 1)
    score = np.zeros((ny, nx), np.float32)
    valid = np.zeros((ny, nx), bool)

    detrend_k = np.ones(61, np.float32) / 61

    for by in range(ny):
        for bx in range(nx):
            y0, x0 = by * STRIDE, bx * STRIDE
            blk = ink[y0 : y0 + BLOCK_H, x0 : x0 + BLOCK_W]
            pap = papyrus[y0 : y0 + BLOCK_H, x0 : x0 + BLOCK_W]
            if pap.mean() < 0.5 or blk.shape[0] < BLOCK_H // 2:
                continue
            valid[by, bx] = True
            cov = blk.mean()
            if cov < 0.02:
                cov_w = cov / 0.02 * 0.3
            elif cov <= 0.45:
                cov_w = 1.0
            else:
                cov_w = max(0.0, 1.0 - (cov - 0.45) / 0.2)
            prof = blk.mean(axis=1)
            trend = np.convolve(prof, detrend_k, mode="same")
            prof = prof - trend
            denom = float((prof * prof).sum())
            period = 0.0
            if denom > 1e-6:
                ac = np.correlate(prof, prof, mode="full")[len(prof) - 1 :]
                ac = ac / denom
                band = ac[MIN_PERIOD : min(MAX_PERIOD, len(ac) - 1)]
                if band.size:
                    # require a genuine local peak, not a monotone tail
                    peak_i = int(band.argmax())
                    peak = float(band[peak_i])
                    is_local = 0 < peak_i < band.size - 1
                    period = max(0.0, peak) if is_local else max(0.0, peak) * 0.5
            score[by, bx] = period * cov_w

    if valid.any():
        v = score[valid]
        lo, hi = np.percentile(v, [10, 90])
        score = np.clip((score - lo) / max(hi - lo, 1e-6), 0, 1)
        score = smooth2d(score, sigma=1.5)
        score = np.clip(score, 0, 1)

    heat = np.zeros((H, W, 4), np.uint8)
    counts = np.zeros((H, W), np.float32)
    acc = np.zeros((H, W), np.float32)
    for by in range(ny):
        for bx in range(nx):
            if not valid[by, bx]:
                continue
            y0, x0 = by * STRIDE, bx * STRIDE
            acc[y0 : y0 + BLOCK_H, x0 : x0 + BLOCK_W] += score[by, bx]
            counts[y0 : y0 + BLOCK_H, x0 : x0 + BLOCK_W] += 1

    s = np.where(counts > 0, acc / np.maximum(counts, 1), 0)
    mask = (counts > 0) & papyrus
    heat[..., 0] = np.where(mask, ((1 - s) * 255).astype(np.uint8), 0)
    heat[..., 1] = np.where(mask, (s * 255).astype(np.uint8), 0)
    heat[..., 2] = 24
    heat[..., 3] = np.where(mask, 110, 0)

    Image.fromarray(heat).save(os.path.join(args.out, "l3.png"))
    good = float((s[mask] > 0.5).mean()) if mask.any() else 0
    print(f"saved l3.png · {100 * good:.0f}% of papyrus scored trustworthy")


if __name__ == "__main__":
    main()
