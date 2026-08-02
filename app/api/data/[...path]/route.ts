// Serve local scroll data (zarr chunk files) to the browser during local dev.
// Public deployments use remote sources directly; this route only exists so the
// Cockpit can display datasets sitting on this machine's disk.
import { promises as fs } from "fs";
import path from "path";

const DATA_ROOT =
  process.env.COCKPIT_DATA_ROOT ??
  "C:/Users/tyler/vesuvius/ink-dataset/phercparis4/w00_20231016151002";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: parts } = await params;
  const rel = parts.join("/");
  const abs = path.resolve(DATA_ROOT, rel);
  if (!abs.startsWith(path.resolve(DATA_ROOT))) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const buf = await fs.readFile(abs);
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
