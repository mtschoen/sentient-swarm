// Runs the GPU checks in sequence: probe, grid, player, simulation, projectiles.
// Usage: node tests/browser/gpu-checks.mjs   (npm run check:gpu)
// Exit codes: 0 all pass, 1 any check failed, 2 the probe found no adapter.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHECKS = ['webgpu-probe', 'grid', 'player', 'simulation', 'projectiles'];
const EXIT_NO_ADAPTER = 2;

let failed = false;
for (const name of CHECKS) {
  const started = performance.now();
  const outcome = spawnSync(process.execPath, [fileURLToPath(new URL(`./${name}.mjs`, import.meta.url))], { stdio: 'inherit' });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`gpu-checks: ${name} exit ${outcome.status} in ${seconds}s`);
  if (name === 'webgpu-probe' && outcome.status === EXIT_NO_ADAPTER) process.exit(EXIT_NO_ADAPTER);
  if (outcome.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
