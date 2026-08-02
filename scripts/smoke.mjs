// Spike 2: can zarrita decode the scroll's blosc/zstd chunks in JS?
import * as zarr from "zarrita";

const URL =
  "https://dl.ash2txt.org/full-scrolls/Scroll1/PHercParis4.volpkg/volumes_zarr_standardized/54keV_7.91um_Scroll1A.zarr/5";

const t0 = Date.now();
const store = new zarr.FetchStore(URL);
const arr = await zarr.open.v2(store, { kind: "array" });
console.log("shape:", arr.shape, "dtype:", arr.dtype, "chunks:", arr.chunks);

const z = Math.floor(arr.shape[0] / 2);
const view = await zarr.get(arr, [z, zarr.slice(null), zarr.slice(null)]);
const data = view.data;
let min = 255, max = 0, sum = 0;
for (let i = 0; i < data.length; i++) {
  const v = data[i];
  if (v < min) min = v;
  if (v > max) max = v;
  sum += v;
}
console.log(
  `slice z=${z}: ${view.shape[0]}x${view.shape[1]} px, min=${min} max=${max} mean=${(sum / data.length).toFixed(1)}, ${Date.now() - t0}ms total`
);
console.log("SPIKE 2 PASSED: JS decodes scroll chunks.");
