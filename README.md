# Murmuration

A browser WebGPU page that simulates hundreds of thousands of flocking enemies of five species entirely on the GPU, rendered as neon glyphs over a reactive warp grid. Run it with `npm install` then `npm run dev` (serves on http://127.0.0.1:5174). Test CPU logic with `npm test`, run the Playwright browser smoke test with `npm run smoke`, and produce a static build with `npm run build` (set `PAGES_BASE` for a sub-path deploy).

## Smoke test

`npm run smoke` starts the Vite dev server on port 5174, opens the page in headless Chromium with WebGPU flags, waits for `window.__murmuration.ready` and for `frame` to reach `--frames N` (default 120), and fails on any console error. Set `SMOKE_URL` to test an already running server. Exit codes: 0 ok, 1 failure, 2 no WebGPU adapter. On this machine headless Chromium gets an adapter, so exit 2 has not been observed; its message is `smoke: WebGPU adapter unavailable in headless Chromium (navigator.gpu missing or requestAdapter() returned null)`.
