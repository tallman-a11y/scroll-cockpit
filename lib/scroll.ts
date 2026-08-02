// Scroll data access: open remote zarr arrays and fetch z-slices.
// Data servers send Access-Control-Allow-Origin: * so the browser talks to them directly.
import * as zarr from "zarrita";

export interface ScrollSource {
  name: string;
  /** Base URL of the multiscale zarr group (levels 0..N as children). */
  url: string;
  levels: number[];
}

export const SOURCES: ScrollSource[] = [
  {
    name: "Scroll 1 (PHerc. Paris 4) — 54keV 7.91µm",
    url: "https://dl.ash2txt.org/full-scrolls/Scroll1/PHercParis4.volpkg/volumes_zarr_standardized/54keV_7.91um_Scroll1A.zarr",
    levels: [0, 1, 2, 3, 4, 5],
  },
  {
    // Local tutorial segment (served by /api/data during dev). Depth axis = 65
    // surface layers around the papyrus recto; z=32 is the surface itself.
    name: "Segment w00_20231016151002 (our ink run) — local",
    url: "/api/data/w00_20231016151002.zarr",
    levels: [5, 4, 3, 2],
  },
];

const arrayCache = new Map<string, Promise<zarr.Array<zarr.DataType>>>();

export function openLevel(source: ScrollSource, level: number) {
  const key = `${source.url}/${level}`;
  let p = arrayCache.get(key);
  if (!p) {
    const store = new zarr.FetchStore(key);
    p = zarr.open.v2(store, { kind: "array" });
    arrayCache.set(key, p);
  }
  return p;
}

export interface SliceResult {
  data: Uint8Array;
  height: number;
  width: number;
}

/** Fetch a full z-slice at the given pyramid level. */
export async function fetchSlice(
  source: ScrollSource,
  level: number,
  z: number
): Promise<SliceResult> {
  const arr = await openLevel(source, level);
  const [depth, height, width] = arr.shape;
  const zi = Math.max(0, Math.min(depth - 1, Math.round(z)));
  const view = await zarr.get(arr, [zi, zarr.slice(null), zarr.slice(null)]);
  return {
    data: view.data as Uint8Array,
    height,
    width,
  };
}

export async function levelShape(source: ScrollSource, level: number) {
  const arr = await openLevel(source, level);
  return arr.shape as number[];
}
