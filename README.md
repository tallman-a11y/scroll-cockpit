# Scroll Cockpit

A zero-install, browser-based viewer (and soon: review/annotation tool) for [Vesuvius Challenge](https://scrollprize.org) scroll data.

Streams CT scan chunks of the Herculaneum scrolls **directly from the challenge's public data servers into your browser** — no backend, no downloads, no toolchain. Open a URL, scrub through a 2,000-year-old scroll.

## Status: v1 (day 2)

- ✅ Direct browser streaming of OME-Zarr scroll volumes (`zarrita` + blosc/zstd decode in JS)
- ✅ Tiled rendering with automatic level-of-detail — whole-scroll to fiber-level (128px tiles, LRU cache)
- ✅ Layers: ink prediction overlay (opacity + hold-F flicker) and reliability heatmap
  (per-region text-line-rhythm score; green = trust, red = wrecked zone)
- ✅ Review loop: Shift+click to mark → 1/2/3 verdict keys with auto-advance → JSON export
  (marks persist in localStorage; zarr label export is next)
- ✅ Local-dataset route for your own segments and predictions during dev
- ✅ Shareable URLs: `?source=&zoom=&rel=`
- ✅ Verdicts → training labels: `scripts/marks_to_labels.py` converts exported marks into
  staged `*_inklabels.zarr` + `*_supervision_mask.zarr` copies (koine_machines convention:
  z=32 surface plane, pyramid regenerated, originals untouched). "ink" = confirmed pseudo-label,
  "not" = negative supervision. Point a training config's `segments_path` at the staging folder.
- 🔜 Triage queue seeded by reliability heatmap; heatmap scoring v2

## Why

The Vesuvius Challenge's [open problems](https://scrollprize.org/2026_open_problems) name **label quality as a primary unwrapping bottleneck** — and the labeling loop today runs on desktop research tools with real setup friction. A browser tool means anyone — researcher, student, papyrologist, kid at the kitchen table — can help sort ink from noise.

Principle: **expectation guides where we look, never what we see.** Layout priors and letterform references live in the human review UI only — never as model evidence.

## Run

```bash
npm install
npm run dev
# open http://localhost:3000
```

To browse a local dataset (e.g. the ink-detection tutorial segment), set `COCKPIT_DATA_ROOT` to the folder containing your `.zarr` and restart.

## Stack

Next.js / TypeScript / Canvas, [`zarrita`](https://github.com/manzt/zarrita.js) for zarr reads. Data courtesy of the Vesuvius Challenge ([EduceLab-Scrolls](https://scrollprize.org), CC-BY-NC for data; this code is MIT).

---

Built by Tyler Allman + Claude. Feedback welcome — find me in the Vesuvius Discord (tylerallman).
