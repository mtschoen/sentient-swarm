# Agent instructions

## Global constraints (binding)

- Plain JavaScript ES modules and WGSL. No TypeScript. No runtime dependencies. Vite and Playwright are dev dependencies only.
- Shaders are loaded with `fetch(new URL('./shaders/<name>.wgsl', import.meta.url))` so the page also runs from any static server without Vite.
- Full-word identifiers (`maximum`, not `max`; `position`, not `pos`) in JavaScript. WGSL may use `vec2f` style built-in names but user identifiers follow the same rule.
- No em-dashes (U+2014) anywhere, including comments and docs.
- Every source file under about 500 lines, or carrying a one-line note at the top saying why.
- No hard-coded machine paths. No wall-clock assertions in tests; inject time.
- Mobile WebGPU limits are designed for: at most 8 storage buffers bound per shader stage; agent data interleaved in 16-byte aligned structs with no `vec3` in storage layouts; `@workgroup_size` at most 256; workgroup memory at most 16 KB; timestamp queries optional.
- Neighbor contributions are averaged, never summed. Per-agent fine-pass neighbor sampling is capped at `MAXIMUM_NEIGHBOR_SAMPLES = 32`.
- Arena is 16 by 9 world units, bounded, fully in view, letterboxed; renderer works in device pixels.
- Species count is 5. Coarse field is 64 by 36 cells with 8 float channels (5 species densities, 1 threat, 2 padding).
- Commit after every task with a message in the imperative; end commit messages with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Commands

- `npm run dev`: dev server on 127.0.0.1:5174 (strictPort).
- `npm run build`: static build into `dist/`, base taken from `PAGES_BASE` (default `/`).
- `npm test`: CPU logic tests via node:test.
- `npm run smoke`: Playwright browser smoke test.

## Pass order

Each animation frame `FrameLoop` runs zero or more fixed update steps, then one render. Each is its own queue submission.

- Update (`Simulation.step`): spawn, grid count, grid scan, grid scatter, coarse field downsample, coarse field blur, steer, integrate, debug kill (only while armed), particle step, stats, stats copy into the staging ring.
- Render (`Renderer.render`): warp grid layer, trails decay, glyphs, particles, bloom, composite.

## File map

- `src/game/`: `loop.js` (fixed-step `FrameLoop`).
- `src/gpu/`: `device.js` (adapter, device, unsupported-browser copy), `buffers.js` (buffer helpers, `StagingRing`), `shaders.js` (shader loading and constant substitution), `bind-group-cache.js`.
- `src/input/`: `input.js` (unified `InputState`), `keyboard.js`, `pointer.js`, `touch.js`, `gamepad.js`.
- `src/render/`: `renderer.js` (frame order, settings), `viewport.js` (letterbox, inspect zoom), `canvas-size.js`, `glyphs.js`, `particles.js`, `trails.js`, `bloom.js`, `warpgrid.js`, `composite.js`, `render-shaders.js`, `capture.js` and `capture-hook.js` (frame readback for the smoke), `shaders/*.wgsl`.
- `src/sim/`: `simulation.js` (facade), `layout.js` (shared constants and sizes), `params.js` (`SimParams` packing), `species.js` (rows, matrix, table packing), `grid.js`, `field.js`, `steer.js`, `spawn.js` (GPU spawn) and `spawner.js` (`SpawnPressure`), `kill.js`, `particles.js`, `stats.js`, `shaders/*.wgsl` (including `common.wgsl`, the shared header).
- `src/ui/`: `debugPanel.js` (DOM panel), `panelModel.js` (slider specs, capacity list, frames-per-second meter, readout text).
- `src/main.js`: boot, wiring, capacity change.
- `tests/<area>/`: node:test files mirroring `src/` (`game`, `gpu`, `input`, `render`, `sim`, `ui`), plus `build.test.js`, `sanity.test.js` and `pages_assembly_test.py`.
- `tests/browser/`: `smoke.mjs`, GPU checks (`grid.mjs`, `steer.mjs`, `simulation.mjs` with their pages under `pages/`), `launch.mjs` and `server.mjs` shared launchers.
