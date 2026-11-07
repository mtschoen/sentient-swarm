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
