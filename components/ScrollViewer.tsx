"use client";
// v0 viewer: stream a z-slice of the scroll from the challenge servers,
// draw to canvas, pan/zoom with mouse, scrub depth with a slider.
import { useCallback, useEffect, useRef, useState } from "react";
import { SOURCES, fetchSlice, levelShape } from "@/lib/scroll";

const DEFAULT_LEVEL = 4; // 16x downsample: fast first paint on any connection

function initialParams() {
  if (typeof window === "undefined") return { source: 0, level: DEFAULT_LEVEL };
  const q = new URLSearchParams(window.location.search);
  const s = Math.min(Number(q.get("source") ?? 0) || 0, SOURCES.length - 1);
  const levels = SOURCES[s].levels;
  const lv = Number(q.get("level"));
  const fallback = levels.includes(DEFAULT_LEVEL) ? DEFAULT_LEVEL : levels[0];
  return {
    source: s,
    level: levels.includes(lv) ? lv : fallback,
  };
}

export default function ScrollViewer() {
  const [init] = useState(initialParams);
  const [sourceIdx, setSourceIdx] = useState(init.source);
  const source = SOURCES[sourceIdx];
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [level, setLevel] = useState(init.level);
  const [depth, setDepth] = useState(0);
  const [z, setZ] = useState(0);
  const [status, setStatus] = useState("connecting…");
  const [loading, setLoading] = useState(false);
  const [inkOpacity, setInkOpacity] = useState(0.7);
  const [inkVisible, setInkVisible] = useState(true);
  const flickerHeld = useRef(false);
  // pan/zoom state kept in refs to avoid re-render churn during drag
  const view = useRef({ x: 0, y: 0, scale: 1 });
  const slice = useRef<ImageData | null>(null);
  const overlayImg = useRef<HTMLCanvasElement | null>(null);
  const inkState = useRef({ opacity: 0.7, visible: true });
  inkState.current = { opacity: inkOpacity, visible: inkVisible };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = slice.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // draw ImageData via offscreen canvas so we can transform it
    const off = document.createElement("canvas");
    off.width = img.width;
    off.height = img.height;
    off.getContext("2d")!.putImageData(img, 0, 0);
    const { x, y, scale } = view.current;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.drawImage(off, 0, 0);
    const ink = inkState.current;
    if (overlayImg.current && ink.visible && !flickerHeld.current) {
      ctx.globalAlpha = ink.opacity;
      ctx.drawImage(overlayImg.current, 0, 0);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }, []);

  // load + tint the prediction overlay for the current source/level
  useEffect(() => {
    overlayImg.current = null;
    const url = source.overlay?.(level);
    if (!url) {
      draw();
      return;
    }
    const im = new window.Image();
    im.onload = () => {
      // tint: prediction intensity -> amber, transparent where no ink
      const c = document.createElement("canvas");
      c.width = im.width;
      c.height = im.height;
      const cctx = c.getContext("2d")!;
      cctx.drawImage(im, 0, 0);
      const d = cctx.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < d.data.length; i += 4) {
        const v = d.data[i];
        d.data[i] = 255;      // R
        d.data[i + 1] = 176;  // G
        d.data[i + 2] = 32;   // B
        // alpha: threshold weak predictions so papyrus texture stays clean,
        // then steepen so confident strokes read solid
        d.data[i + 3] = v < 72 ? 0 : Math.min(255, (v - 72) * 1.8);
      }
      cctx.putImageData(d, 0, 0);
      overlayImg.current = c;
      draw();
    };
    im.src = url;
  }, [source, level, draw]);

  // F key = flicker the ink layer off while held (stroke-vs-texture check)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "f" && !flickerHeld.current) {
        flickerHeld.current = true;
        draw();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "f") {
        flickerHeld.current = false;
        draw();
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [draw]);

  const load = useCallback(
    async (lv: number, zi: number) => {
      setLoading(true);
      setStatus(`streaming slice z=${zi} @ level ${lv}…`);
      const t0 = performance.now();
      try {
        const { data, height, width } = await fetchSlice(source, lv, zi);
        const img = new ImageData(width, height);
        for (let i = 0; i < data.length; i++) {
          const v = data[i];
          img.data[i * 4] = v;
          img.data[i * 4 + 1] = v;
          img.data[i * 4 + 2] = v;
          img.data[i * 4 + 3] = 255;
        }
        slice.current = img;
        draw();
        setStatus(
          `z=${zi} · level ${lv} · ${width}×${height} · ${((performance.now() - t0) / 1000).toFixed(1)}s`
        );
      } catch (e) {
        setStatus(`error: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setLoading(false);
      }
    },
    [source, draw]
  );

  // Unregister any stale service workers left on localhost:3000 by other
  // local apps — they intercept fetches and poison caching.
  useEffect(() => {
    navigator.serviceWorker
      ?.getRegistrations()
      .then((rs) => rs.forEach((r) => r.unregister()))
      .catch(() => {});
  }, []);

  // init: read shape, center view, load middle slice
  useEffect(() => {
    (async () => {
      const [d, h, w] = await levelShape(source, level);
      setDepth(d);
      const canvas = canvasRef.current!;
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
      const scale = Math.min(canvas.width / w, canvas.height / h) * 0.95;
      view.current = {
        scale,
        x: (canvas.width - w * scale) / 2,
        y: (canvas.height - h * scale) / 2,
      };
      const mid = Math.floor(d / 2);
      setZ(mid);
      await load(level, mid);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, sourceIdx]);

  // pan + zoom
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
      draw();
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const v = view.current;
      v.x = mx - (mx - v.x) * factor;
      v.y = my - (my - v.y) * factor;
      v.scale *= factor;
      draw();
    };
    canvas.addEventListener("mousedown", down);
    window.addEventListener("mouseup", up);
    window.addEventListener("mousemove", move);
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => {
      canvas.removeEventListener("mousedown", down);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("mousemove", move);
      canvas.removeEventListener("wheel", wheel);
    };
  }, [draw]);

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-200">
      <header className="flex items-center gap-4 border-b border-neutral-800 px-4 py-2 text-sm">
        <span className="font-semibold tracking-wide text-amber-400">SCROLL COCKPIT</span>
        <select
          className="max-w-96 rounded bg-neutral-800 px-2 py-1 text-neutral-300"
          value={sourceIdx}
          onChange={(e) => {
            const idx = Number(e.target.value);
            setSourceIdx(idx);
            setLevel(SOURCES[idx].levels[0]);
          }}
        >
          {SOURCES.map((s, i) => (
            <option key={s.url} value={i}>
              {s.name}
            </option>
          ))}
        </select>
        <label className="ml-auto flex items-center gap-2">
          level
          <select
            className="rounded bg-neutral-800 px-2 py-1"
            value={level}
            onChange={(e) => setLevel(Number(e.target.value))}
          >
            {source.levels.map((l) => (
              <option key={l} value={l}>
                {l} ({2 ** l}x)
              </option>
            ))}
          </select>
        </label>
        <span className={loading ? "text-amber-400" : "text-neutral-500"}>{status}</span>
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
                requestAnimationFrame(draw);
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
              requestAnimationFrame(draw);
            }}
          />
          <span className="text-neutral-500">hold F to flicker ink off — real strokes snap in and out; texture stays</span>
        </div>
      )}
      <div className="flex items-center gap-3 border-b border-neutral-800 px-4 py-2 text-sm">
        <span className="w-24 text-neutral-400">depth z={z}</span>
        <input
          className="flex-1 accent-amber-400"
          type="range"
          min={0}
          max={Math.max(depth - 1, 0)}
          value={z}
          onChange={(e) => setZ(Number(e.target.value))}
          onMouseUp={() => load(level, z)}
          onTouchEnd={() => load(level, z)}
        />
      </div>
      <canvas ref={canvasRef} className="flex-1 cursor-grab active:cursor-grabbing" />
    </div>
  );
}
