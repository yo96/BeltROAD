# BeltROAD — Factorio 2.0 EDA Blueprint Generator

An Electronic Design Automation (EDA) studio and CLI for **Factorio 2.0** blueprints. Specify target items and rates, configure your technology PDK (belt tiers, assemblers, inserters, power poles, modules, N×M balancer book), constrain perimeter port locations and macro floorplans, and synthesize → place → route → verify → export valid Factorio 2.0 blueprint strings (`0eN...`).

**Playable Web App (GitHub Pages):** https://yo96.github.io/BeltROAD/

## Pipeline & Key Features

1. **Synthesis & Tech-Mapping**: Computes machine counts, belt tiers, balanced slicing, productivity/speed module effects, and automatic multi-stage `1×2` inline splitter trunk-and-tap decomposition (`opt_bus_split`).
2. **Soft-Macro Compilation & Hard-IP Balancers**: Back-to-back mirrored 2-row and 1-row machine blocks, dual-lane T-merge input manifolds for 3+ low-rate ingredients, vertical Y-mirroring (`flipY`), plus built-in & Factorio 1.1/2.0 blueprint-book N×M balancers.
3. **Layered Floorplanning & Zero-Braid Pin Matching**: Topological stage column placement with 5-sweep Sugiyama barycenter ordering, automatic 2-band folding, 2D compaction, isotonic pin alignment, and minimum-cost bipartite port swapping (`opt_port_swap`).
4. **High-Discipline Manhattan Router (No Belt Weaving)**: Typed-array negotiated-congestion PathFinder with strict underground non-weaving, bus-hugging channels, rip-up straightening, and dual-order routing trials.
5. **PDN & Signoff Verification**: Connected electric pole grid builder, full physical DRC (`COLLISION`, `UNDERGROUND_PAIR`, `NO_BELT_WEAVING`, `INSERTER_VALID`, `NO_SIDE_LOAD_CONTAMINATION`, `POWER_COVERAGE`, `POWER_CONNECTIVITY`, `DIE_BOUNDS`), and Static Throughput Analysis (**STA**).
6. **Dual Visualization Modes**:
   - **Factorio View**: Concrete floorpad, neighbor-aware curved belts, splitters, undergrounds, assemblers/furnaces, inserters, sagging copper wires, Alt-Mode CDN icons, and optional client-side local `Factorio/data/base/graphics` sprite sheet loader.
   - **EDA Schematic**: Blueprint-blue schematic view with utilization heatmap, flylines, supply area overlays, interactive pin/macro drag-and-drop, SVG export, YAML spec editor, and shareable URL hashes.

## Workspace Packages

- `@factorio-eda/core` (`packages/core`): Pure TypeScript EDA engine (zero DOM dependencies).
- `@factorio-eda/cli` (`packages/cli`): `feda` command-line tool (`synth`, `build`, `verify`, `import-balancers`).
- `@factorio-eda/web` (`packages/web`): Static client-side Vite + React + HTML5 Canvas + Web Worker workbench.

## Quick Start

```bash
npm install
npm test
npm run build
npm run dev
```

### CLI Usage

```bash
node packages/cli/dist/index.js synth examples/red-green-science.yaml
node packages/cli/dist/index.js build examples/red-green-science.yaml -o bp.txt --svg layout.svg
node packages/cli/dist/index.js verify examples/red-circuits.yaml
```
