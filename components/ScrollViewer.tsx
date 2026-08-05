"use client";
// Tiled scroll viewer + review loop.
// - Map-style streaming with automatic level-of-detail (world space = full-res px)
// - Layers: surface tiles, ink prediction overlay, reliability heatmap
// - Review: Shift+click marks a spot; 1/2/3 = ink / not ink / unsure;
//   N/P next/prev; Delete removes; queue panel; JSON export.
import { useCallback, useEffect, useRef, useState } from "react";
import { TILE, getTile, levelShape, visibleSources } from "@/lib/scroll";
import { type ChunkPatch, loadXyzIndex, maskToCanvas, queryChunk } from "@/lib/chunks";

const MAX_TILES = 800;
const MAX_INFLIGHT = 12;

interface Mark {
  id: string;
  x: number; // world coords (full-res px)
  y: number;
  z: number; // depth when marked
  verdict: null | "ink" | "not" | "unsure";
  ts: number;
}

const VERDICT_COLORS: Record<string, string> = {
  ink: "#34d399",
  not: "#f87171",
  unsure: "#a3a3a3",
  pending: "#fbbf24",
};

function initialParams() {
  const q = new URLSearchParams(window.location.search);
  const s = Math.min(Number(q.get("source") ?? 0) || 0, visibleSources().length - 1);
  const zoom = Math.max(Number(q.get("zoom")) || 1, 0.1);
  return {
    source: s,
    zoom,
    rel: q.get("rel") === "1",
    diff: q.get("diff") === "1",
    chunk: (q.get("chunk") ?? "").replace(/,/g, " "),
  };
}

export default function ScrollViewer() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className="h-screen bg-neutral-950" />;
  return <Viewer />;
}

function Viewer() {
  const [init] = useState(initialParams);
  const [sourceIdx, setSourceIdx] = useState(init.source);
  const sources = visibleSources();
  const source = sources[sourceIdx];
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [worldDepth, setWorldDepth] = useState(0);
  const [z, setZ] = useState(0);
  const [status, setStatus] = useState("connecting…");
  const [inkOpacity, setInkOpacity] = useState(0.7);
  const [inkVisible, setInkVisible] = useState(true);
  const [relVisible, setRelVisible] = useState(init.rel);
  const [diffVisible, setDiffVisible] = useState(init.diff);
  const diffCanvas = useRef<HTMLCanvasElement | null>(null);
  const diffState = useRef(init.diff);
  diffState.current = diffVisible;
  const [marks, setMarks] = useState<Mark[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [chunkText, setChunkText] = useState(init.chunk);
  const autoChunkDone = useRef(false);
  const [chunkPatches, setChunkPatches] = useState<ChunkPatch[]>([]);
  const [chunkStatus, setChunkStatus] = useState("");
  const chunkMask = useRef<HTMLCanvasElement | null>(null);
  const chunkScale = useRef({ x: 1, y: 1 });

  const view = useRef({ x: 0, y: 0, scale: 1 });
  const shapes = useRef(new Map<number, number[]>());
  const world = useRef({ d: 0, h: 0, w: 0, finest: 0 });
  const tiles = useRef(new Map<string, HTMLCanvasElement>());
  const inflight = useRef(new Set<string>());
  const overlays = useRef(new Map<number, HTMLCanvasElement>());
  const staticImgs = useRef(new Map<number, HTMLImageElement>());
  const staticLoading = useRef(new Set<number>());
  const relCanvas = useRef<HTMLCanvasElement | null>(null);
  const zRef = useRef(0);
  const flickerHeld = useRef(false);
  const inkState = useRef({ opacity: 0.7, visible: true });
  const relState = useRef(init.rel);
  const marksRef = useRef<Mark[]>([]);
  const selectedRef = useRef<string | null>(null);
  inkState.current = { opacity: inkOpacity, visible: inkVisible };
  relState.current = relVisible;
  zRef.current = z;
  marksRef.current = marks;
  selectedRef.current = selectedId;

  const storageKey = `cockpit-marks::${source.url}`;

  // load/save marks
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      setMarks(raw ? (JSON.parse(raw) as Mark[]) : []);
    } catch {
      setMarks([]);
    }
    setSelectedId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceIdx]);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(marks));
    } catch {}
  }, [marks, storageKey]);

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
    const { x: vx, y: vy, scale: vs } = view.current;

    const drawOverlaysAndMarks = (c: CanvasRenderingContext2D, scale: number) => {
      if (source.reliability && relState.current && relCanvas.current) {
        const rc = relCanvas.current;
        c.drawImage(rc, 0, 0, rc.width * 8, rc.height * 8);
      }
      if (source.difficulty && diffState.current && diffCanvas.current) {
        const dc = diffCanvas.current;
        c.drawImage(dc, 0, 0, dc.width * 8, dc.height * 8);
      }
      if (chunkMask.current) {
        const cm = chunkMask.current;
        c.drawImage(cm, 0, 0, cm.width * chunkScale.current.x, cm.height * chunkScale.current.y);
      }
      const ink = inkState.current;
      if (source.overlay && ink.visible && !flickerHeld.current) {
        const oLevels = [3, 4, 5].filter((l) => source.overlay!(l));
        const oL = oLevels.find((l) => overlays.current.has(l));
        if (oL !== undefined) {
          const oc = overlays.current.get(oL)!;
          c.globalAlpha = ink.opacity;
          c.drawImage(oc, 0, 0, oc.width * 2 ** oL, oc.height * 2 ** oL);
          c.globalAlpha = 1;
        }
      }
      for (const m of marksRef.current) {
        const r = 16 / scale;
        const color = VERDICT_COLORS[m.verdict ?? "pending"];
        c.beginPath();
        c.arc(m.x, m.y, r, 0, Math.PI * 2);
        c.strokeStyle = color;
        c.lineWidth = (m.id === selectedRef.current ? 5 : 2.5) / scale;
        c.stroke();
        c.beginPath();
        c.arc(m.x, m.y, 2 / scale, 0, Math.PI * 2);
        c.fillStyle = color;
        c.fill();
      }
    };

    if (source.staticImages) {
      ctx.save();
      ctx.translate(vx, vy);
      ctx.scale(vs, vs);
      const img = staticImgs.current.get(L);
      if (img) {
        ctx.drawImage(img, 0, 0, img.width * 2 ** L, img.height * 2 ** L);
      } else {
        // draw any loaded level as a stand-in, then fetch the wanted one
        for (const l of [...source.levels].sort((a, b) => b - a)) {
          const im2 = staticImgs.current.get(l);
          if (im2) {
            ctx.drawImage(im2, 0, 0, im2.width * 2 ** l, im2.height * 2 ** l);
            break;
          }
        }
        if (!staticLoading.current.has(L)) {
          staticLoading.current.add(L);
          const im = new window.Image();
          im.onload = () => {
            staticImgs.current.set(L, im);
            requestAnimationFrame(drawRef.current);
          };
          im.src = source.staticImages(L);
        }
      }
      drawOverlaysAndMarks(ctx, vs);
      ctx.restore();
      setStatus(`level ${L} · ${Math.round(vs * 100)}%`);
      return;
    }

    const zl = zAtLevel(L);
    const f = 2 ** L;
    const shape = shapes.current.get(L);
    if (!shape) return;
    const [, H, W] = shape;

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

    drawOverlaysAndMarks(ctx, vs);
    ctx.restore();

    setStatus(
      `level ${L} · z=${zRef.current}${missing ? ` · ${missing} tiles loading` : ""} · ${Math.round(
        view.current.scale * 100
      )}%`
    );
  }, [source, sourceIdx, pickLevel, zAtLevel]);
  const drawRef = useRef(draw);
  drawRef.current = draw;

  const flyTo = useCallback((m: Mark) => {
    const canvas = canvasRef.current!;
    const vs = Math.max(view.current.scale, 0.5); // at least level-1-ish detail
    view.current = {
      scale: vs,
      x: canvas.width / 2 - m.x * vs,
      y: canvas.height / 2 - m.y * vs,
    };
    setSelectedId(m.id);
    requestAnimationFrame(drawRef.current);
  }, []);

  const setVerdict = useCallback((v: "ink" | "not" | "unsure") => {
    const sel = selectedRef.current;
    if (!sel) return;
    setMarks((ms) => ms.map((m) => (m.id === sel ? { ...m, verdict: v } : m)));
    // auto-advance to next pending mark
    const list = marksRef.current;
    const idx = list.findIndex((m) => m.id === sel);
    const next =
      list.slice(idx + 1).find((m) => m.verdict === null && m.id !== sel) ??
      list.find((m) => m.verdict === null && m.id !== sel);
    if (next) flyToRef.current(next);
    requestAnimationFrame(drawRef.current);
  }, []);
  const flyToRef = useRef(flyTo);
  flyToRef.current = flyTo;
  const setVerdictRef = useRef(setVerdict);
  setVerdictRef.current = setVerdict;

  // init source
  useEffect(() => {
    let alive = true;
    (async () => {
      setStatus("connecting…");
      tiles.current.clear();
      overlays.current.clear();
      staticImgs.current.clear();
      staticLoading.current.clear();
      relCanvas.current = null;
      if (source.staticImages) {
        // world dims from the coarsest static level
        const coarsest = Math.max(...source.levels);
        const dims = await new Promise<{ w: number; h: number }>((resolve, reject) => {
          const im = new window.Image();
          im.onload = () => {
            staticImgs.current.set(coarsest, im);
            resolve({ w: im.width, h: im.height });
          };
          im.onerror = reject;
          im.src = source.staticImages!(coarsest);
        });
        if (!alive) return;
        const cf = 2 ** coarsest;
        world.current = { finest: Math.min(...source.levels), d: 1, h: dims.h * cf, w: dims.w * cf };
      } else {
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
      }
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
      diffCanvas.current = null;
      if (source.difficulty) {
        const dim = new window.Image();
        dim.onload = () => {
          const c = document.createElement("canvas");
          c.width = dim.width;
          c.height = dim.height;
          c.getContext("2d")!.drawImage(dim, 0, 0);
          diffCanvas.current = c;
          requestAnimationFrame(drawRef.current);
        };
        dim.src = source.difficulty;
      }

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
    let moved = 0;
    let last = { x: 0, y: 0 };
    const toWorld = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const { x: vx, y: vy, scale: vs } = view.current;
      return {
        x: (e.clientX - rect.left - vx) / vs,
        y: (e.clientY - rect.top - vy) / vs,
      };
    };
    const down = (e: MouseEvent) => {
      dragging = true;
      moved = 0;
      last = { x: e.clientX, y: e.clientY };
    };
    const up = (e: MouseEvent) => {
      if (!dragging) return;
      dragging = false;
      if (moved > 5 || e.target !== canvas) return;
      const w = toWorld(e);
      if (e.shiftKey) {
        const m: Mark = {
          id: Math.random().toString(36).slice(2, 10),
          x: Math.round(w.x),
          y: Math.round(w.y),
          z: zRef.current,
          verdict: null,
          ts: Date.now(),
        };
        setMarks((ms) => [...ms, m]);
        setSelectedId(m.id);
      } else {
        // select nearest mark within 24 screen px
        const vs = view.current.scale;
        let best: Mark | null = null;
        let bestD = 24 / vs;
        for (const m of marksRef.current) {
          const d = Math.hypot(m.x - w.x, m.y - w.y);
          if (d < bestD) {
            bestD = d;
            best = m;
          }
        }
        setSelectedId(best ? best.id : null);
      }
      requestAnimationFrame(drawRef.current);
    };
    const move = (e: MouseEvent) => {
      if (!dragging) return;
      moved += Math.abs(e.clientX - last.x) + Math.abs(e.clientY - last.y);
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
      const k = e.key.toLowerCase();
      if (k === "f") {
        const held = e.type === "keydown";
        if (flickerHeld.current !== held) {
          flickerHeld.current = held;
          requestAnimationFrame(drawRef.current);
        }
        return;
      }
      if (e.type !== "keydown") return;
      if (k === "1") setVerdictRef.current("ink");
      else if (k === "2") setVerdictRef.current("not");
      else if (k === "3") setVerdictRef.current("unsure");
      else if (k === "delete" || k === "backspace") {
        const sel = selectedRef.current;
        if (sel) {
          setMarks((ms) => ms.filter((m) => m.id !== sel));
          setSelectedId(null);
          requestAnimationFrame(drawRef.current);
        }
      } else if (k === "n" || k === "p") {
        const list = marksRef.current;
        if (!list.length) return;
        const idx = list.findIndex((m) => m.id === selectedRef.current);
        const next =
          k === "n"
            ? list[(idx + 1 + list.length) % list.length]
            : list[(idx - 1 + list.length) % list.length];
        flyToRef.current(next);
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

  const runChunkQuery = async () => {
    if (!source.chunkIndex) return;
    const nums = chunkText.trim().split(/[\s,;]+/).map(Number).filter((n) => !isNaN(n));
    if (nums.length !== 6) {
      setChunkStatus("need 6 numbers: x0 y0 z0 x1 y1 z1");
      return;
    }
    setChunkStatus("querying…");
    try {
      const idx = await loadXyzIndex(source.chunkIndex);
      const min: [number, number, number] = [
        Math.min(nums[0], nums[3]),
        Math.min(nums[1], nums[4]),
        Math.min(nums[2], nums[5]),
      ];
      const max: [number, number, number] = [
        Math.max(nums[0], nums[3]),
        Math.max(nums[1], nums[4]),
        Math.max(nums[2], nums[5]),
      ];
      const { mask, patches } = queryChunk(idx, min, max);
      chunkMask.current = maskToCanvas(idx, mask);
      chunkScale.current = { x: idx.fullresPerPxX, y: idx.fullresPerPxY };
      setChunkPatches(patches);
      setChunkStatus(
        patches.length
          ? `${patches.length} patch${patches.length > 1 ? "es" : ""} (wraps) intersect this chunk`
          : "surface does not pass through this chunk"
      );
      if (patches.length) {
        const [bx, by, bw, bh] = patches[0].bbox;
        const canvas = canvasRef.current!;
        const vs = Math.min(canvas.width / (bw * 2.5), canvas.height / (bh * 2.5));
        view.current = {
          scale: vs,
          x: canvas.width / 2 - (bx + bw / 2) * vs,
          y: canvas.height / 2 - (by + bh / 2) * vs,
        };
      }
      requestAnimationFrame(drawRef.current);
    } catch (e) {
      setChunkStatus(`error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const runChunkQueryRef = useRef<() => void>(() => {});
  runChunkQueryRef.current = runChunkQuery;

  // auto-run ?chunk= query once the source is ready
  useEffect(() => {
    if (init.chunk && source.chunkIndex && worldDepth > 0 && !autoChunkDone.current) {
      autoChunkDone.current = true;
      setTimeout(() => runChunkQueryRef.current(), 400);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldDepth, sourceIdx]);

  const flyToPatch = (p: ChunkPatch) => {
    const [bx, by, bw, bh] = p.bbox;
    const canvas = canvasRef.current!;
    const vs = Math.min(canvas.width / (bw * 2.5), canvas.height / (bh * 2.5));
    view.current = {
      scale: vs,
      x: canvas.width / 2 - (bx + bw / 2) * vs,
      y: canvas.height / 2 - (by + bh / 2) * vs,
    };
    requestAnimationFrame(drawRef.current);
  };

  const exportMarks = () => {
    const payload = {
      tool: "scroll-cockpit",
      source: source.url,
      exported: new Date().toISOString(),
      marks: marks,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `cockpit-marks-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const pending = marks.filter((m) => m.verdict === null).length;

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-200">
      <header className="flex items-center gap-4 border-b border-neutral-800 px-4 py-2 text-sm">
        <span className="font-semibold tracking-wide text-amber-400">SCROLL COCKPIT</span>
        <select
          className="max-w-96 rounded bg-neutral-800 px-2 py-1 text-neutral-300"
          value={sourceIdx}
          onChange={(e) => setSourceIdx(Number(e.target.value))}
        >
          {sources.map((s, i) => (
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
            hold F to flicker · Shift+click to mark · 1 ink / 2 not / 3 unsure · N next
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
              reliability
            </label>
          )}
          {source.difficulty && (
            <label className="flex items-center gap-2 text-fuchsia-400">
              <input
                type="checkbox"
                className="accent-fuchsia-400"
                checked={diffVisible}
                onChange={(e) => {
                  setDiffVisible(e.target.checked);
                  requestAnimationFrame(drawRef.current);
                }}
              />
              difficulty (mesh curvature+compression)
            </label>
          )}
        </div>
      )}
      <div
        className="flex items-center gap-3 border-b border-neutral-800 px-4 py-2 text-sm"
        style={source.staticImages ? { display: "none" } : undefined}
      >
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
      <div className="flex min-h-0 flex-1">
        <canvas ref={canvasRef} className="min-w-0 flex-1 cursor-grab active:cursor-grabbing" />
        <aside className="flex w-72 flex-col border-l border-neutral-800 bg-neutral-925">
          <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2 text-sm">
            <span className="font-medium text-neutral-300">
              Review queue{" "}
              <span className="text-neutral-500">
                ({marks.length - pending}/{marks.length})
              </span>
            </span>
            <div className="flex gap-2">
              <button
                className="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700"
                onClick={exportMarks}
                disabled={!marks.length}
              >
                export
              </button>
              <button
                className="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700"
                onClick={() => {
                  setMarks([]);
                  setSelectedId(null);
                  requestAnimationFrame(drawRef.current);
                }}
                disabled={!marks.length}
              >
                clear
              </button>
            </div>
          </div>
          {source.chunkIndex && (
            <div className="border-b border-neutral-800 px-3 py-2 text-xs">
              <div className="mb-1 font-medium text-neutral-300">3D chunk query</div>
              <textarea
                className="mb-1 w-full resize-none rounded bg-neutral-800 px-2 py-1 font-mono text-[11px] text-neutral-200"
                rows={2}
                placeholder="x0 y0 z0 x1 y1 z1 (volume coords)"
                value={chunkText}
                onChange={(e) => setChunkText(e.target.value)}
              />
              <div className="flex items-center gap-2">
                <button
                  className="rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700"
                  onClick={runChunkQuery}
                >
                  find patches
                </button>
                <button
                  className="rounded bg-neutral-800 px-2 py-1 hover:bg-neutral-700"
                  onClick={() => {
                    chunkMask.current = null;
                    setChunkPatches([]);
                    setChunkStatus("");
                    requestAnimationFrame(drawRef.current);
                  }}
                >
                  clear
                </button>
                <span className="text-neutral-500">{chunkStatus}</span>
              </div>
              {chunkPatches.map((p, i) => (
                <button
                  key={i}
                  className="mt-1 flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-neutral-900"
                  onClick={() => flyToPatch(p)}
                >
                  <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
                  wrap {i + 1}: ({p.bbox[0]}, {p.bbox[1]}) {p.bbox[2]}×{p.bbox[3]}
                </button>
              ))}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {marks.length === 0 && (
              <p className="px-3 py-4 text-xs leading-5 text-neutral-500">
                Shift+click anywhere on the papyrus to mark a spot for review. Then
                press 1 (real ink), 2 (not ink), or 3 (unsure) — the view advances
                to the next pending mark automatically.
              </p>
            )}
            {marks.map((m, i) => (
              <button
                key={m.id}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-neutral-900 ${
                  m.id === selectedId ? "bg-neutral-900" : ""
                }`}
                onClick={() => flyTo(m)}
              >
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ background: VERDICT_COLORS[m.verdict ?? "pending"] }}
                />
                <span className="text-neutral-300">#{i + 1}</span>
                <span className="text-neutral-500">
                  ({m.x}, {m.y}) z{m.z}
                </span>
                <span className="ml-auto text-neutral-400">{m.verdict ?? "—"}</span>
              </button>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
