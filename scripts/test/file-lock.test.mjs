import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
  return path.join(dir, 'test.json');
}

test('file-lock: basic acquire and release', async () => {
  const lockMod = await import('../lib/file-lock.cjs');
  const file = tempFile();
  const lock = lockMod.acquireLock(file);
  assert.ok(lock.acquired);
  assert.ok(fs.existsSync(file + '.lock'));
  lock.release();
  assert.ok(!fs.existsSync(file + '.lock'));
});

test('file-lock: second acquire fails while held', async () => {
  const lockMod = await import('../lib/file-lock.cjs');
  const file = tempFile();
  const lock = lockMod.acquireLock(file);
  assert.throws(() => lockMod.acquireLock(file), /already running|cannot acquire/);
  lock.release();
});

test('file-lock: malformed lock fails closed', async () => {
  const lockMod = await import('../lib/file-lock.cjs');
  const file = tempFile();
  const lockPath = file + '.lock';
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, 'not json');
  assert.throws(() => lockMod.acquireLock(file), /malformed/);
});

test('file-lock: concurrent child processes - only one acquires', async () => {
  const file = tempFile();
  const script = `
    const m = require('${root.replace(/\\/g, '/')}/scripts/lib/file-lock.cjs');
    const f = process.argv[2];
    try {
      const lock = m.acquireLock(f);
      process.stdout.write('ACQUIRED\\n');
      setTimeout(() => { lock.release(); process.stdout.write('RELEASED\\n'); process.exit(0); }, 1000);
    } catch (e) {
      process.stdout.write('BLOCKED: ' + e.message.substring(0, 40) + '\\n');
      process.exit(0);
    }
  `;
  // Launch two child processes concurrently
  const p1 = spawn('node', ['-e', script, file], { stdio: ['pipe', 'pipe', 'pipe'] });
  const p2 = spawn('node', ['-e', script, file], { stdio: ['pipe', 'pipe', 'pipe'] });

  let out1 = '', out2 = '';
  p1.stdout.on('data', d => { out1 += d; });
  p2.stdout.on('data', d => { out2 += d; });

  await new Promise(resolve => {
    let done = 0;
    p1.on('exit', () => { done++; if (done === 2) resolve(); });
    p2.on('exit', () => { done++; if (done === 2) resolve(); });
  });

  const combined = out1 + out2;
  // Exactly one should have acquired
  const acquiredCount = (combined.match(/ACQUIRED/g) || []).length;
  assert.equal(acquiredCount, 1, 'exactly one process should acquire the lock');
  // The other should be blocked
  assert.ok(combined.includes('BLOCKED'), 'the other process should be blocked');
});

test('file-lock: wrong owner cannot release lock', async () => {
  const lockMod = await import('../lib/file-lock.cjs');
  const file = tempFile();
  const lock1 = lockMod.acquireLock(file);
  const lockPath = file + '.lock';
  // Attempt to release with a foreign token
  const foreignToken = { pid: 99999, token: 'foreign-token', createdAt: new Date().toISOString() };
  lockMod.releaseLock(lockPath, foreignToken);
  // Lock should still be held by the original owner
  assert.ok(fs.existsSync(lockPath), 'lock should still exist after foreign release attempt');
  assert.throws(() => lockMod.acquireLock(file), /already running|cannot acquire/, 'lock should still be held');
  // Original owner can still release
  lock1.release();
  assert.ok(!fs.existsSync(lockPath), 'lock should be released by original owner');
  // Can re-acquire
  const lock2 = lockMod.acquireLock(file);
  assert.ok(lock2.acquired);
  lock2.release();
});
