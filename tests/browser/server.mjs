// Starts the Vite dev server for browser checks. Node runs the vite entry point
// directly so the child can be killed reliably on Windows.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// SMOKE_PORT lets parallel checkouts run their smoke side by side.
const DEFAULT_SERVER_PORT = 5174;
const SERVER_PORT = Number(process.env.SMOKE_PORT) || DEFAULT_SERVER_PORT;
const START_TIMEOUT_MILLISECONDS = 20_000;
const POLL_MILLISECONDS = 200;
const STOP_TIMEOUT_MILLISECONDS = 5_000;
// Matches the ANSI color and cursor escape sequences Vite writes around its URL.
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text) {
  return text.replace(ANSI_PATTERN, '');
}

// True once the child's own output names the URL it serves, so a foreign server already
// listening on the port cannot pass for this child (strictPort makes Vite exit instead).
export function outputNamesUrl(output, url) {
  return stripAnsi(output).includes(url);
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', resolve));
}

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
  // Kills the child and resolves once it has exited (a forced kill after a grace period).
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = waitForExit(child);
    child.kill();
    const forced = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MILLISECONDS);
    await exited;
    clearTimeout(forced);
  };
  const deadline = Date.now() + START_TIMEOUT_MILLISECONDS;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`vite exited early:\n${output}`);
    if (outputNamesUrl(output, url)) {
      try {
        const response = await fetch(url);
        if (response.ok) return { child, url, stop };
      } catch { /* not listening yet */ }
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`vite did not start in time:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MILLISECONDS));
  }
}
