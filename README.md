# Scroll Cockpit

A zero-install, browser-based viewer (and soon: review/annotation tool) for [Vesuvius Challenge](https://scrollprize.org) scroll data.

Streams CT scan chunks of the Herculaneum scrolls **directly from the challenge's public data servers into your browser** — no backend, no downloads, no toolchain. Open a URL, scrub through a 2,000-year-old scroll.

## Status: v0 (day 1)

- ✅ Direct browser streaming of OME-Zarr scroll volumes (`zarrita` + blosc/zstd decode in JS)
- ✅ Pan / zoom / depth-scrub across pyramid levels
- ✅ Local-dataset route for viewing your own segments and predictions during dev
- 🔜 Viewport tiling (stream only what's visible at high res)
- 🔜 Layers: ink predictions + labels over surface volume, opacity + A/B flicker
- 🔜 Keyboard review loop: confirm / reject / unsure → training-label export
- 🔜 Review triage ordered by text-line layout priors

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
