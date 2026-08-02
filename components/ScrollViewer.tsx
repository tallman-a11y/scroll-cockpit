"use client";
// v0 viewer: stream a z-slice of the scroll from the challenge servers,
// draw to canvas, pan/zoom with mouse, scrub depth with a slider.
import { useCallback, useEffect, useRef, useState } from "react";
import { SOURCES, fetchSlice, levelShape } from "@/lib/scroll";

const DEFAULT_LEVEL = 4; // 16x downsample: fast first paint on any connection

export default function ScrollViewer() {
  const [sourceIdx, setSourceIdx] = useState(0);
  const source = SOURCES[sourceIdx];
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [level, setLevel] = useState(DEFAULT_LEVEL);
  const [depth, setDepth] = useState(0);
  const [z, setZ] = useState(0);
  const [status, setStatus] = useState("connecting…");
  const [loading, setLoading] = useState(false);
  // pan/zoom state kept in refs to avoid re-render churn during drag
  const view = useRef({ x: 0, y: 0, scale: 1 });
  const slice = useRef<ImageData | null>(null);

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
    ctx.restore();
  }, []);

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
