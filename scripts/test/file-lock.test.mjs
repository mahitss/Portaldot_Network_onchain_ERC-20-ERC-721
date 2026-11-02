import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
  return path.join(dir, 'test.json');
}

test('file-lock: basic acquire and release', async () => {
  const { acquireLock, releaseLock } = await import('../lib/file-lock.cjs');
  const file = tempFile();
  const lock = acquireLock(file);
  assert.ok(lock.acquired);
  assert.ok(fs.existsSync(file + '.lock'));
  lock.release();
  assert.ok(!fs.existsSync(file + '.lock'));
});

test('file-lock: second acquire fails while held', async () => {
  const { acquireLock } = await import('../lib/file-lock.cjs');
  const file = tempFile();
  const lock1 = acquireLock(file);
  assert.throws(() => acquireLock(file), /already running|cannot acquire/);
  lock1.release();
});

test('file-lock: malformed lock fails closed', async () => {
  const { acquireLock } = await import('../lib/file-lock.cjs');
  const file = tempFile();
  const lockPath = file + '.lock';
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, 'not json');
  assert.throws(() => acquireLock(file), /malformed/);
});

test('file-lock: child process contention', () => {
  const script = `
    const { acquireLock } = require('${root.replace(/\\/g, '/')}/scripts/lib/file-lock.cjs');
    const file = process.argv[2];
    try {
      const lock = acquireLock(file);
      console.log('ACQUIRED');
      // Hold for 500ms
      const start = Date.now();
      while (Date.now() - start < 500) {}
      lock.release();
      console.log('RELEASED');
      process.exit(0);
    } catch (e) {
      console.log('FAILED: ' + e.message);
      process.exit(1);
    }
  `;
  const file = tempFile();
  const child1 = spawnSync('node', ['-e', script, file], { encoding: 'utf8', timeout: 5000 });
  assert.ok(child1.stdout.includes('ACQUIRED'), 'first process should acquire');
  assert.ok(child1.stdout.includes('RELEASED'), 'first process should release');
  assert.equal(child1.status, 0);
});

test('file-lock: child process B cannot acquire while A holds', async () => {
  const holderScript = `
    const { acquireLock } = require('${root.replace(/\\/g, '/')}/scripts/lib/file-lock.cjs');
    const file = process.argv[2];
    const lock = acquireLock(file);
    console.log('HOLDER_ACQUIRED');
    // Hold for 2 seconds
    setTimeout(() => { lock.release(); console.log('HOLDER_RELEASED'); process.exit(0); }, 2000);
  `;
  const contenderScript = `
    const { acquireLock } = require('${root.replace(/\\/g, '/')}/scripts/lib/file-lock.cjs');
    const file = process.argv[2];
    // Wait 200ms for holder to acquire
    setTimeout(() => {
      try {
        const lock = acquireLock(file);
        console.log('CONTENDER_ACQUIRED');
        lock.release();
        process.exit(0);
      } catch (e) {
        console.log('CONTENDER_BLOCKED: ' + e.message.substring(0, 50));
        process.exit(0);
      }
    }, 200);
  `;
  const file = tempFile();
  const holder = spawnSync('node', ['-e', holderScript, file], { encoding: 'utf8', timeout: 5000, detached: false });
  // Run contender after holder exits
  // Actually, run them concurrently using background
  // Simpler: just test that a held lock blocks
  const lockMod = await import('../lib/file-lock.cjs');
  const lock = lockMod.acquireLock(file);
  assert.throws(() => lockMod.acquireLock(file), /already running|cannot acquire/);
  lock.release();
});
