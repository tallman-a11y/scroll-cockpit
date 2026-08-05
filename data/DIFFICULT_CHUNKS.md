# Difficult chunks — curvature + compression ranking

Per the Vesuvius Challenge team, surface-model failures concentrate where the papyrus shows
"curvature + compression," and (as of Aug 2026) no ranked list of those regions existed —
finding them meant manually eyeballing viewers. This is a first automated pass.

## Method

From a segment's public `.obj` mesh (`scripts/compute_difficulty.py`):

- **Compression** = |log(3D face area / flattened-UV face area)| — parameterization distortion.
  Physically squeezed papyrus can't flatten cleanly; the Jacobian gives it away.
- **Curvature** = mean dihedral angle between each face and its neighbors — local bending.
- Both are rasterized on a 64px grid over the segment's flattened coordinates, percentile-
  normalized, combined as max(curvature, compression), and:
  - rendered as `difficulty_l3.png` (a Cockpit overlay layer — toggle "difficulty", or `?diff=1`)
  - ranked into `difficult_chunks.json` / `.csv`: top-50 1024px chunks with **flattened bbox**
    (for ink review / labeling) and **3D volume bbox** (for carving surface-model training chunks).

## Files

- `difficult_chunks.json` — segment 20231016151002 (Scroll 1 / PHerc. Paris 4), top 50
- `difficult_chunks.csv` — same, spreadsheet-friendly
- Overlay visible live: https://scroll-cockpit.vercel.app/?source=1&diff=1

## Caveats (v1)

- Scores are relative within one segment (percentile-normalized) — cross-segment comparison
  needs a shared normalization pass over many meshes.
- Mesh-resolution limited (~44px triangle spacing); fine wrinkles below that scale are invisible.
- "Difficult for surface models" is inferred from geometry, not measured from model errors —
  validating against actual prediction-failure maps is the obvious next step (and the
  reliability heatmap in this repo is one half of that comparison).

Feedback welcome — if this is useful, the same script runs on any segment mesh in
`/paths/` on the data server, so a whole-scroll (or all-scrolls) list is just compute.
