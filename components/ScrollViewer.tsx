"use client";
// Tiled scroll viewer: map-style streaming with automatic level-of-detail.
// World space = full-resolution pixel coordinates; zoom picks the pyramid
// level, and only visible 128px tiles are fetched and cached (LRU).
import { useCallback, useEffect, useRef, useState } from "react";
import { SOURCES, TILE, getTile, levelShape } from "@/lib/scroll";

const MAX_TILES = 800; // LRU cap ≈ 50 MB decoded
const MAX_INFLIGHT = 12;

function initialParams() {
  if (typeof window === "undefined") return { source: 0, zoom: 1, rel: false };
  const q = new URLSearchParams(window.location.search);
  const s = Math.min(Number(q.get("source") ?? 0) || 0, SOURCES.length - 1);
  const zoom = Math.max(Number(q.get("zoom")) || 1, 0.1);
  return { source: s, zoom, rel: q.get("rel") === "1" };
}

export default function ScrollViewer() {
  const [init] = useState(initialParams);
  const [sourceIdx, setSourceIdx] = useState(init.source);
  const source = SOURCES[sourceIdx];
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [worldDepth, setWorldDepth] = useState(0);
  const [z, setZ] = useState(0);
  const [status, setStatus] = useState("connecting…");
  const [inkOpacity, setInkOpacity] = useState(0.7);
  const [inkVisible, setInkVisible] = useState(true);
  const [relVisible, setRelVisible] = useState(init.rel);
  const relCanvas = useRef<HTMLCanvasElement | null>(null);
  const relState = useRef(init.rel);
  relState.current = relVisible;

  const view = useRef({ x: 0, y: 0, scale: 1 });
  const shapes = useRef(new Map<number, number[]>()); // level -> [d,h,w]
  const world = useRef({ d: 0, h: 0, w: 0, finest: 0 });
  const tiles = useRef(new Map<string, HTMLCanvasElement>());
  const inflight = useRef(new Set<string>());
  const overlays = useRef(new Map<number, HTMLCanvasElement>());
  const zRef = useRef(0);
  const flickerHeld = useRef(false);
  const inkState = useRef({ opacity: 0.7, visible: true });
  inkState.current = { opacity: inkOpacity, visible: inkVisible };
  zRef.current = z;

  const pickLevel = useCallback(() => {
    const ideal = Math.floor(Math.log2(1 / view.current.scale));
    const avail = [...source.levels].sort((a, b) => a - b);
    let best = avail[avail.length - 1];
    for (const l of avail) {
      if (l >= ideal) {
        best = l;
        break;
      }
    }
    return Math.max(best, avail[0]);
  }, [source]);

  const zAtLevel = useCallback(
    (level: number) => {
      const d = shapes.current.get(level)?.[0] ?? 1;
      const zl = source.depthScales ? zRef.current >> level : zRef.current;
      return Math.max(0, Math.min(d - 1, zl));
    },
    [source]
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !world.current.w) return;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const L = pickLevel();
    const zl = zAtLevel(L);
    const f = 2 ** L;
    const shape = shapes.current.get(L);
    if (!shape) return;
    const [, H, W] = shape;
    const { x: vx, y: vy, scale: vs } = view.current;

    // visible world rect -> level-space tile range
    const wx0 = Math.max(0, -vx / vs);
    const wy0 = Math.max(0, -vy / vs);
    const wx1 = Math.min(world.current.w, (canvas.width - vx) / vs);
    const wy1 = Math.min(world.current.h, (canvas.height - vy) / vs);
    const ty0 = Math.max(0, Math.floor(wy0 / f / TILE));
    const tx0 = Math.max(0, Math.floor(wx0 / f / TILE));
    const ty1 = Math.min(Math.ceil(H / TILE) - 1, Math.floor((wy1 / f - 1) / TILE));
    const tx1 = Math.min(Math.ceil(W / TILE) - 1, Math.floor((wx1 / f - 1) / TILE));

    ctx.save();
    ctx.translate(vx, vy);
    ctx.scale(vs, vs);

    let missing = 0;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const key = `${sourceIdx}/${L}/${zl}/${ty}/${tx}`;
        const tile = tiles.current.get(key);
        if (tile) {
          // LRU touch
          tiles.current.delete(key);
          tiles.current.set(key, tile);
          ctx.drawImage(tile, tx * TILE * f, ty * TILE * f, tile.width * f, tile.height * f);
        } else {
          missing++;
          ctx.fillStyle = "#151515";
          ctx.fillRect(tx * TILE * f, ty * TILE * f, TILE * f, TILE * f);
          if (inflight.current.size < MAX_INFLIGHT && !inflight.current.has(key)) {
            inflight.current.add(key);
            getTile(source, L, zl, ty, tx)
              .then(({ data, h, w }) => {
                const c = document.createElement("canvas");
                c.width = w;
                c.height = h;
                const img = new ImageData(w, h);
                for (let i = 0; i < data.length; i++) {
                  const v = data[i];
                  img.data[i * 4] = v;
                  img.data[i * 4 + 1] = v;
                  img.data[i * 4 + 2] = v;
                  img.data[i * 4 + 3] = 255;
                }
                c.getContext("2d")!.putImageData(img, 0, 0);
                tiles.current.set(key, c);
                while (tiles.current.size > MAX_TILES) {
                  const oldest = tiles.current.keys().next().value!;
                  tiles.current.delete(oldest);
                }
              })
              .catch(() => {})
              .finally(() => {
                inflight.current.delete(key);
                requestAnimationFrame(drawRef.current);
              });
          }
        }
      }
    }

    // reliability heatmap (level-3 aligned, 8x world scale)
    if (source.reliability && relState.current && relCanvas.current) {
      const rc = relCanvas.current;
      ctx.drawImage(rc, 0, 0, rc.width * 8, rc.height * 8);
    }

    // ink overlay (segment sources): draw finest available overlay in world space
    const ink = inkState.current;
    if (source.overlay && ink.visible && !flickerHeld.current) {
      const oLevels = [3, 4, 5].filter((l) => source.overlay!(l));
      const oL = oLevels.find((l) => overlays.current.has(l));
      if (oL !== undefined) {
        const oc = overlays.current.get(oL)!;
        ctx.globalAlpha = ink.opacity;
        ctx.drawImage(oc, 0, 0, oc.width * 2 ** oL, oc.height * 2 ** oL);
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();

    setStatus(
      `level ${L} · z=${zRef.current}${missing ? ` · ${missing} tiles loading` : ""} · ${Math.round(
        view.current.scale * 100
      )}%`
    );
  }, [source, sourceIdx, pickLevel, zAtLevel]);
  const drawRef = useRef(draw);
  drawRef.current = draw;

  // init source: shapes for all levels, world dims, fit view, mid depth
  useEffect(() => {
    let alive = true;
    (async () => {
      setStatus("connecting…");
      tiles.current.clear();
      overlays.current.clear();
      const entries = await Promise.all(
        source.levels.map(async (l) => [l, await levelShape(source, l)] as const)
      );
      if (!alive) return;
      shapes.current = new Map(entries);
      const finest = Math.min(...source.levels);
      const [fd, fh, fw] = shapes.current.get(finest)!;
      const ff = 2 ** finest;
      world.current = {
        finest,
        d: source.depthScales ? fd * ff : fd,
        h: fh * ff,
        w: fw * ff,
      };
      setWorldDepth(world.current.d);
      const mid = Math.floor(world.current.d / 2);
      setZ(mid);
      zRef.current = mid;

      const canvas = canvasRef.current!;
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
      const fit =
        Math.min(canvas.width / world.current.w, canvas.height / world.current.h) * 0.95;
      const scale = fit * init.zoom;
      view.current = {
        scale,
        x: (canvas.width - world.current.w * scale) / 2,
        y: (canvas.height - world.current.h * scale) / 2,
      };

      // load reliability heatmap
      relCanvas.current = null;
      if (source.reliability) {
        const rim = new window.Image();
        rim.onload = () => {
          const c = document.createElement("canvas");
          c.width = rim.width;
          c.height = rim.height;
          c.getContext("2d")!.drawImage(rim, 0, 0);
          relCanvas.current = c;
          requestAnimationFrame(drawRef.current);
        };
        rim.src = source.reliability;
      }

      // load tinted overlays
      for (const l of [3, 4, 5]) {
        const url = source.overlay?.(l);
        if (!url) continue;
        const im = new window.Image();
        im.onload = () => {
          const c = document.createElement("canvas");
          c.width = im.width;
          c.height = im.height;
          const cctx = c.getContext("2d")!;
          cctx.drawImage(im, 0, 0);
          const d = cctx.getImageData(0, 0, c.width, c.height);
          for (let i = 0; i < d.data.length; i += 4) {
            const v = d.data[i];
            d.data[i] = 255;
            d.data[i + 1] = 176;
            d.data[i + 2] = 32;
            d.data[i + 3] = v < 72 ? 0 : Math.min(255, (v - 72) * 1.8);
          }
          cctx.putImageData(d, 0, 0);
          overlays.current.set(l, c);
          requestAnimationFrame(drawRef.current);
        };
        im.src = url;
      }
      draw();
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceIdx]);

  // interactions
  useEffect(() => {
    const canvas = canvasRef.current!;
    let dragging = false;
    let last = { x: 0, y: 0 };
    const down = (e: MouseEvent) => {
      dragging = true;
      last = { x: e.clientX, y: e.clientY };
    };
    const up = () => (dragging = false);
    const move = (e: MouseEvent) => {
      if (!dragging) return;
      view.current.x += e.clientX - last.x;
      view.current.y += e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      requestAnimationFrame(drawRef.current);
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      const v = view.current;
      v.x = mx - (mx - v.x) * factor;
      v.y = my - (my - v.y) * factor;
      v.scale *= factor;
      requestAnimationFrame(drawRef.current);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "f") {
        const held = e.type === "keydown";
        if (flickerHeld.current !== held) {
          flickerHeld.current = held;
          requestAnimationFrame(drawRef.current);
        }
      }
    };
    const resize = () => {
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
      requestAnimationFrame(drawRef.current);
    };
    canvas.addEventListener("mousedown", down);
    window.addEventListener("mouseup", up);
    window.addEventListener("mousemove", move);
    canvas.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", key);
    window.addEventListener("resize", resize);
    return () => {
      canvas.removeEventListener("mousedown", down);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("mousemove", move);
      canvas.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", key);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-200">
      <header className="flex items-center gap-4 border-b border-neutral-800 px-4 py-2 text-sm">
        <span className="font-semibold tracking-wide text-amber-400">SCROLL COCKPIT</span>
        <select
          className="max-w-96 rounded bg-neutral-800 px-2 py-1 text-neutral-300"
          value={sourceIdx}
          onChange={(e) => setSourceIdx(Number(e.target.value))}
        >
          {SOURCES.map((s, i) => (
            <option key={s.url} value={i}>
              {s.name}
            </option>
          ))}
        </select>
        <span className="ml-auto text-neutral-500">{status}</span>
      </header>
      {source.overlay && (
        <div className="flex items-center gap-3 border-b border-neutral-800 px-4 py-2 text-sm">
          <label className="flex items-center gap-2 text-amber-400">
            <input
              type="checkbox"
              className="accent-amber-400"
              checked={inkVisible}
              onChange={(e) => {
                setInkVisible(e.target.checked);
                requestAnimationFrame(drawRef.current);
              }}
            />
            ink layer
          </label>
          <input
            className="w-48 accent-amber-400"
            type="range"
            min={0}
            max={100}
            value={inkOpacity * 100}
            onChange={(e) => {
              setInkOpacity(Number(e.target.value) / 100);
              requestAnimationFrame(drawRef.current);
            }}
          />
          <span className="text-neutral-500">
            hold F to flicker ink off — real strokes snap in and out; texture stays
          </span>
          {source.reliability && (
            <label className="ml-auto flex items-center gap-2 text-emerald-400">
              <input
                type="checkbox"
                className="accent-emerald-400"
                checked={relVisible}
                onChange={(e) => {
                  setRelVisible(e.target.checked);
                  requestAnimationFrame(drawRef.current);
                }}
              />
              reliability (green = trust, red = wrecked)
            </label>
          )}
        </div>
      )}
      <div className="flex items-center gap-3 border-b border-neutral-800 px-4 py-2 text-sm">
        <span className="w-24 text-neutral-400">depth z={z}</span>
        <input
          className="flex-1 accent-amber-400"
          type="range"
          min={0}
          max={Math.max(worldDepth - 1, 0)}
          value={z}
          onChange={(e) => {
            const nz = Number(e.target.value);
            setZ(nz);
            zRef.current = nz;
            requestAnimationFrame(drawRef.current);
          }}
        />
      </div>
      <canvas ref={canvasRef} className="flex-1 cursor-grab active:cursor-grabbing" />
    </div>
  );
}
