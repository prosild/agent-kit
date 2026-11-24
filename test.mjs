// Unified regression test runner for agent-kit (runs all 6 zero-dependency test suites).
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SUITES = [
  'hooks/guard.test.mjs',
  'hooks/pre-push.test.mjs',
  'install.test.mjs',
  'verify.test.mjs',
  'cleanup.test.mjs',
  'update-tools.test.mjs',
];

const filter = process.argv[2] ? process.argv[2].toLowerCase() : '';
const targets = filter ? SUITES.filter((s) => s.toLowerCase().includes(filter)) : SUITES;
if (!targets.length) {
  console.error(`No suite matched filter: ${filter}`);
  process.exit(2);
}

let failed = 0;
const tStart = Date.now();
for (const suite of targets) {
  const s0 = Date.now();
  const r = spawnSync(process.execPath, [join(ROOT, suite)], { cwd: ROOT, encoding: 'utf8' });
  const elapsed = ((Date.now() - s0) / 1000).toFixed(1);
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${suite} (${elapsed}s)`);
  if (!ok) {
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
  }
}

const totalSec = ((Date.now() - tStart) / 1000).toFixed(1);
console.log(failed ? `\nSUITES FAILED: ${failed}/${targets.length} (${totalSec}s)` : `\nALL ${targets.length} SUITES PASSED (${totalSec}s)`);
process.exit(failed ? 1 : 0);
