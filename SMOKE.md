# Sentient Swarm smoke checklist

## Phone checklist for a pull request preview

Run this on the owner's devices: the foldable Android in Chrome and an iPhone in Safari. Open the preview link for the pull request on each.

1. The title screen shows "SENTIENT SWARM" with Play, Lab and Settings. Held in portrait, an overlay asks for landscape.
2. Rotate to landscape. The overlay goes away and the arena fills the screen with the HUD in the side bands (or along the top edge on a narrow screen).
3. Tap Play (or tap anywhere on the title screen). The run starts, the arena clears, and music begins on the first tap (check sound is on and the phone is not muted).
4. Left thumb: the floating move stick moves the ship. Right thumb: the floating aim stick aims and fires. Both work at once.
5. Tap the bomb button (lower right). The arena clears, the bomb count drops by one, a short buzz plays where the browser allows it, and the ship does not fire.
6. Touch a HUD panel and the Settings button: neither starts a stick.
7. Pick up a weapon and let it expire: the charge ring drains only while firing, and the ship returns to the base gun when it empties. Also pick up a rail pickup and check that rear turrets appear on the HUD and fire behind the ship.
8. Die once: the arena clears with a flash, the ship respawns after a short pause, and lives drop by one.
9. Pause with the pause button (top centre). The pause menu shows and the game freezes; Resume continues.
10. Play for two minutes. The frame rate should feel smooth, with no stutter bursts and no growing lag.
11. Open Settings (bottom left button, or Settings in the pause menu) and note the Quality preset shown. Write it down with the device name: this is the preset the frame-time probe chose.
12. Record anything wrong: device, browser, step number, and what happened.

Pass: every step behaves as written, with no crash, no black screen and no stuck input.

## Automated checks

Run from the repository root. The browser scripts start their own Vite dev server on `SMOKE_PORT` (default 5174; set it, for example `SMOKE_PORT=5184`, to run from parallel checkouts) and need a WebGPU adapter (exit code 2 means none).

- `npm test`: CPU logic tests (node:test). `npm run coverage` runs them with the coverage gate.
- `npm run smoke` (`tests/browser/smoke.mjs`): boots the page with `?probe=off&capacity=262144`, checks Ready, the click start, the start clear, luminance and the audio unlock.
- `npm run smoke -- --play N`: a synthetic gamepad plays N frames and needs a positive score.
- `node tests/browser/smoke-menu.mjs`: title and pause menus, Escape and Options pause, Quit to title.
- `node tests/browser/smoke-lab.mjs`: malformed `#mix=` hashes, Watch, Play, Share and the shared link round trip.
- `node tests/browser/mobile-smoke.mjs`: touch emulation at 844x390 and 915x412, sticks, bomb button, score.
- `node tests/browser/quality.mjs`: live preset steps through the quality probe, with the alive agents carried over.
- `node tests/browser/audio-render.mjs`: offline renders of the music and effects (levels and sections); never plays through the speakers.
- `node tests/browser/render-capture.mjs --out <directory> [--compare <directory>]`: a deterministic render capture per bloom quality; compare against an earlier capture to catch rendering drift. Local only.
- GPU checks in `tests/browser/`: `npm run check:gpu` runs `webgpu-probe.mjs`, `grid.mjs`, `player.mjs`, `simulation.mjs`, `projectiles.mjs` and `bloom.mjs` in sequence (`WEBGPU_ADAPTER=fallback` forces the software adapter); `steer.mjs` runs on its own.

### Where each runs

- Every push and pull request (`check.yml`): `npm test`, `npm run coverage`, `npm run build`, and an advisory `npm run check:gpu` on the software adapter.
- Main pushes and manual dispatch on a self-hosted GPU runner (`browser.yml`): the smokes, `quality.mjs`, `check:gpu`, `steer.mjs` and `bloom.mjs`.
- Local only: `audio-render.mjs`, `render-capture.mjs`, the capture scripts and the phone checklist above.
