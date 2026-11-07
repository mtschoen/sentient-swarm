// Starts the Vite dev server for browser checks. Node runs the vite entry point
// directly so the child can be killed reliably on Windows.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// SMOKE_PORT lets parallel checkouts run their smoke side by side.
const DEFAULT_SERVER_PORT = 5174;
const SERVER_PORT = Number(process.env.SMOKE_PORT) || DEFAULT_SERVER_PORT;
const START_TIMEOUT_MILLISECONDS = 20_000;

export async function startServer() {
  const viteEntry = join(dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin', 'vite.js');
  const child = spawn(
    process.execPath,
    [viteEntry, '--host', '127.0.0.1', '--port', String(SERVER_PORT), '--strictPort'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const url = `http://127.0.0.1:${SERVER_PORT}/`;
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + START_TIMEOUT_MILLISECONDS;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`vite exited early:\n${output}`);
    try {
      const response = await fetch(url);
      if (response.ok) return { child, url };
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`vite did not start in time:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
