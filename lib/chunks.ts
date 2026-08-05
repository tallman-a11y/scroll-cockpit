// In-browser chunk queries: given a 3D volume bbox, find the flattened
// regions of a segment whose surface passes through it (multi-wrap aware).
// Powered by a compact quantized xyz index shipped as a static asset.

export interface XyzIndex {
  width: number;
  height: number;
  lo: number[];
  hi: number[];
  fullresPerPxX: number;
  fullresPerPxY: number;
  planes: Uint16Array; // 3 * h * w, 0 = invalid
}

export interface ChunkPatch {
  /** flattened full-res bbox [x, y, w, h] */
  bbox: [number, number, number, number];
  pixels: number;
}

const cache = new Map<string, Promise<XyzIndex>>();

export function loadXyzIndex(baseUrl: string): Promise<XyzIndex> {
  let p = cache.get(baseUrl);
  if (!p) {
    p = (async () => {
      const meta = await (await fetch(`${baseUrl}/xyz_index.json`)).json();
      const buf = await (await fetch(`${baseUrl}/xyz_index.bin`)).arrayBuffer();
      return {
        width: meta.width,
        height: meta.height,
        lo: meta.lo,
        hi: meta.hi,
        fullresPerPxX: meta.fullres_per_px_x,
        fullresPerPxY: meta.fullres_per_px_y,
        planes: new Uint16Array(buf),
      };
    })();
    cache.set(baseUrl, p);
  }
  return p;
}

/** Mask + connected patches of the surface inside volume bbox (xyz min/max). */
export function queryChunk(
  idx: XyzIndex,
  min: [number, number, number],
  max: [number, number, number]
): { mask: Uint8Array; patches: ChunkPatch[] } {
  const { width: w, height: h, lo, hi, planes } = idx;
  const n = w * h;
  const mask = new Uint8Array(n);
  const q = (axis: number, v: number) =>
    ((v - lo[axis]) * 65534) / Math.max(hi[axis] - lo[axis], 1e-9) + 1;
  const qmin = [q(0, min[0]), q(1, min[1]), q(2, min[2])];
  const qmax = [q(0, max[0]), q(1, max[1]), q(2, max[2])];
  for (let i = 0; i < n; i++) {
    const x = planes[i];
    if (x === 0) continue;
    if (x < qmin[0] || x > qmax[0]) continue;
    const y = planes[n + i];
    if (y < qmin[1] || y > qmax[1]) continue;
    const z = planes[2 * n + i];
    if (z < qmin[2] || z > qmax[2]) continue;
    mask[i] = 1;
  }

  // connected components (4-neighborhood, iterative flood fill)
  const patches: ChunkPatch[] = [];
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  for (let start = 0; start < n; start++) {
    if (!mask[start] || seen[start]) continue;
    let minX = w, minY = h, maxX = 0, maxY = 0, count = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const px = i % w;
      const py = (i / w) | 0;
      count++;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      if (px > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (px < w - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (py > 0 && mask[i - w] && !seen[i - w]) { seen[i - w] = 1; stack.push(i - w); }
      if (py < h - 1 && mask[i + w] && !seen[i + w]) { seen[i + w] = 1; stack.push(i + w); }
    }
    if (count < 12) continue; // speckle
    patches.push({
      bbox: [
        Math.round(minX * idx.fullresPerPxX),
        Math.round(minY * idx.fullresPerPxY),
        Math.round((maxX - minX + 1) * idx.fullresPerPxX),
        Math.round((maxY - minY + 1) * idx.fullresPerPxY),
      ],
      pixels: count,
    });
  }
  patches.sort((a, b) => b.pixels - a.pixels);
  return { mask, patches };
}

/** Render the query mask as a tinted overlay canvas in index resolution. */
export function maskToCanvas(idx: XyzIndex, mask: Uint8Array): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = idx.width;
  c.height = idx.height;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(idx.width, idx.height);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    img.data[i * 4] = 50;
    img.data[i * 4 + 1] = 220;
    img.data[i * 4 + 2] = 120;
    img.data[i * 4 + 3] = 150;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
