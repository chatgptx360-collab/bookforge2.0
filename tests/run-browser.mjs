/**
 * Runs the browser suites strictly one file at a time.
 *
 * `node --test` starts a process per file, and three suites at once means
 * three Chromium instances and three dev servers competing for the same few
 * cores. Every suite passes alone and several fail together — a result that
 * says nothing about the app and everything about the machine. Serialising
 * costs a couple of minutes and makes a failure mean something.
 *
 * Written as a script rather than a shell loop so it behaves the same on
 * Windows, which is where this project is actually run.
 */

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const here = new URL('.', import.meta.url).pathname;
const suites = readdirSync(here)
  .filter((name) => name.endsWith('.browser.mjs'))
  .sort();

if (suites.length === 0) {
  console.error('no browser suites found');
  process.exit(1);
}

let failed = 0;

for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', join(here, suite)], { stdio: 'inherit' });
    child.on('exit', (value) => resolve(value ?? 1));
  });
  if (code !== 0) failed++;
}

if (failed > 0) {
  console.error(`\n${failed} of ${suites.length} browser suites failed`);
  process.exit(1);
}
console.log(`\nall ${suites.length} browser suites passed`);
