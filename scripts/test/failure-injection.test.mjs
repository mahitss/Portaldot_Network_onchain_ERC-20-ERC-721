// Mission 006.20.2 §5: failure-injection tests for the journal descriptor
// lifecycle, shared durability handling, and record persistence.
//
// These tests inject a mock `fs` object (delegating to node:fs with selected
// methods overridden to throw) so that close/fsync/write/rename/unlink
// failures can be exercised deterministically without global monkey-patching
// or platform-specific filesystem manipulation.
//
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Build an fs object that delegates to node:fs, with selected methods
// overridden to throw the provided errors.
function makeInjectableFs(overrides = {}) {
  const real = require('node:fs');
  const injected = {};
  for (const key of Object.keys(real)) {
    injected[key] = real[key];
  }
  for (const key of Object.keys(overrides)) {
    injected[key] = overrides[key];
  }
  return injected;
}

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fail-inject-'));
  return path.join(dir, 'test.json');
}

function basicEntry(opts = {}) {
  return {
    schemaVersion: 1,
    operationId: opts.operationId || 'op-inject-1',
    operation: 'deploy',
    contract: 'PotERC20',
    txHash: '0x' + 'aa'.repeat(32),
    signed: '0x' + 'bb'.repeat(64),
    expectedSender: '0x' + '11'.repeat(20),
    chainId: 420420777,
    nonce: 0,
    expectedTo: null,
    expectedValue: '0',
    expectedData: '0x6080604052',
    params: { artifact: 'PotERC20', gasLimit: '100000', args: [] },
    createdAt: new Date().toISOString(),
    attempts: 0,
    status: 'pending',
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// Journal file close failure (persistPendingEntry)
// ---------------------------------------------------------------------------

test('failure-injection: journal close failure propagates and aborts publication', async () => {
  const { persistPendingEntry } = await import('../lib/transaction-journal.cjs');
  const file = tempFile();
  const entry = basicEntry();
  const mockFs = makeInjectableFs({
    closeSync: () => { throw new Error('mock close failure'); },
  });
  assert.throws(
    () => persistPendingEntry(file, entry, mockFs),
    /cannot close temporary journal file/,
    'close failure must propagate'
  );
  // No journal may be published after a failed close.
  assert.equal(fs.existsSync(file + '.journal'), false, 'no journal published after close failure');
});

// ---------------------------------------------------------------------------
// Journal file fsync failure (persistPendingEntry)
// ---------------------------------------------------------------------------

test('failure-injection: journal fsync failure propagates and cleans up temp', async () => {
  const { persistPendingEntry } = await import('../lib/transaction-journal.cjs');
  const file = tempFile();
  const entry = basicEntry();
  const mockFs = makeInjectableFs({
    fsyncSync: () => { throw new Error('mock fsync failure'); },
  });
  assert.throws(
    () => persistPendingEntry(file, entry, mockFs),
    /cannot write journal/,
    'fsync failure must propagate'
  );
  // Temp file must be cleaned up.
  const dir = path.dirname(file);
  const tmpFiles = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(tmpFiles, [], 'no temp file after fsync failure');
  assert.equal(fs.existsSync(file + '.journal'), false, 'no journal after fsync failure');
});

// ---------------------------------------------------------------------------
// Temporary cleanup failure (write path)
// ---------------------------------------------------------------------------

test('failure-injection: cleanup failure after write failure is aggregated', async () => {
  const { persistPendingEntry } = await import('../lib/transaction-journal.cjs');
  const file = tempFile();
  const entry = basicEntry();
  const mockFs = makeInjectableFs({
    writeSync: () => { throw new Error('mock write failure'); },
    unlinkSync: (p) => { throw new Error('mock unlink failure'); },
  });
  assert.throws(
    () => persistPendingEntry(file, entry, mockFs),
    /mock write failure.*mock unlink failure|mock unlink failure.*mock write failure/,
    'write failure and cleanup failure must be aggregated'
  );
  assert.equal(fs.existsSync(file + '.journal'), false, 'no journal after aggregated failure');
});

// ---------------------------------------------------------------------------
// Terminal journal close failure (persistTerminalFailure)
// ---------------------------------------------------------------------------

test('failure-injection: terminal journal close failure propagates, publication aborted', async () => {
  const { persistPendingEntry, persistTerminalFailure, readPendingJournal } =
    await import('../lib/transaction-journal.cjs');
  const file = tempFile();
  const entry = basicEntry();
  persistPendingEntry(file, entry);
  const mockFs = makeInjectableFs({
    closeSync: () => { throw new Error('mock terminal close failure'); },
  });
  assert.throws(
    () => persistTerminalFailure(file, { receipt: { transactionHash: entry.txHash, status: 0, blockNumber: 5 } }, mockFs),
    /cannot close temporary terminal failure journal/,
    'terminal close failure must propagate'
  );
  // Original pending journal must be preserved.
  const result = readPendingJournal(file);
  assert.equal(result.status, 'ok', 'original pending journal preserved after close failure');
  assert.equal(result.entry.txHash, entry.txHash);
});

// ---------------------------------------------------------------------------
// Terminal publication failure (persistTerminalFailure)
// ---------------------------------------------------------------------------

test('failure-injection: terminal publication failure preserves the pending journal', async () => {
  const { persistPendingEntry, persistTerminalFailure, readPendingJournal } =
    await import('../lib/transaction-journal.cjs');
  const file = tempFile();
  const entry = basicEntry();
  persistPendingEntry(file, entry);
  const mockFs = makeInjectableFs({
    renameSync: () => { throw Object.assign(new Error('mock rename failure'), { code: 'EXDEV' }); },
  });
  assert.throws(
    () => persistTerminalFailure(file, { receipt: { transactionHash: entry.txHash, status: 0, blockNumber: 5 } }, mockFs),
    /cannot publish terminal failure journal/,
    'terminal publication failure must propagate'
  );
  // Original pending journal must be preserved untouched.
  const result = readPendingJournal(file);
  assert.equal(result.status, 'ok', 'original pending journal preserved after publication failure');
  assert.equal(result.entry.txHash, entry.txHash);
});

// ---------------------------------------------------------------------------
// Existing journal preserved after every failed terminal conversion
// ---------------------------------------------------------------------------

test('failure-injection: existing journal preserved after failed terminal write', async () => {
  const { persistPendingEntry, persistTerminalFailure, readPendingJournal } =
    await import('../lib/transaction-journal.cjs');
  const file = tempFile();
  const entry = basicEntry();
  persistPendingEntry(file, entry);
  const mockFs = makeInjectableFs({
    writeSync: () => { throw new Error('mock terminal write failure'); },
  });
  assert.throws(() => persistTerminalFailure(file, {
    receipt: { transactionHash: entry.txHash, status: 0, blockNumber: 5 },
  }, mockFs));
  const result = readPendingJournal(file);
  assert.equal(result.status, 'ok');
  assert.equal(result.entry.txHash, entry.txHash);
});

test('failure-injection: existing journal preserved after failed terminal fsync', async () => {
  const { persistPendingEntry, persistTerminalFailure, readPendingJournal } =
    await import('../lib/transaction-journal.cjs');
  const file = tempFile();
  const entry = basicEntry();
  persistPendingEntry(file, entry);
  const mockFs = makeInjectableFs({
    fsyncSync: () => { throw new Error('mock terminal fsync failure'); },
  });
  assert.throws(() => persistTerminalFailure(file, {
    receipt: { transactionHash: entry.txHash, status: 0, blockNumber: 5 },
  }, mockFs));
  const result = readPendingJournal(file);
  assert.equal(result.status, 'ok');
  assert.equal(result.entry.txHash, entry.txHash);
});

// ---------------------------------------------------------------------------
// Record write and fsync failure (persistence.cjs writeJsonAtomic)
// ---------------------------------------------------------------------------

test('failure-injection: record write failure propagates and cleans up temp', async () => {
  const { writeJsonAtomic } = await import('../lib/persistence.cjs');
  const file = tempFile();
  const mockFs = makeInjectableFs({
    writeSync: () => { throw new Error('mock record write failure'); },
  });
  assert.throws(() => writeJsonAtomic(file, { foo: 'bar' }, mockFs), /mock record write failure/);
  assert.equal(fs.existsSync(file), false, 'no record after write failure');
});

test('failure-injection: record fsync failure propagates and cleans up temp', async () => {
  const { writeJsonAtomic } = await import('../lib/persistence.cjs');
  const file = tempFile();
  const mockFs = makeInjectableFs({
    fsyncSync: () => { throw new Error('mock record fsync failure'); },
  });
  assert.throws(() => writeJsonAtomic(file, { foo: 'bar' }, mockFs), /mock record fsync failure/);
  assert.equal(fs.existsSync(file), false, 'no record after fsync failure');
});

// ---------------------------------------------------------------------------
// Record rename failure (persistence.cjs writeJsonAtomic)
// ---------------------------------------------------------------------------

test('failure-injection: record rename failure propagates, temp cleaned up', async () => {
  const { writeJsonAtomic } = await import('../lib/persistence.cjs');
  const file = tempFile();
  const mockFs = makeInjectableFs({
    renameSync: () => { throw Object.assign(new Error('mock rename failure'), { code: 'EXDEV' }); },
  });
  assert.throws(() => writeJsonAtomic(file, { foo: 'bar' }, mockFs), /mock rename failure/);
  assert.equal(fs.existsSync(file), false, 'no record after rename failure');
});

// ---------------------------------------------------------------------------
// Directory fsync unsupported
// ---------------------------------------------------------------------------

test('failure-injection: directory fsync unsupported is reported, not swallowed', async () => {
  const { fsyncDirectory } = await import('../lib/durability.cjs');
  const dir = path.dirname(tempFile());
  fs.mkdirSync(dir, { recursive: true });
  const result = fsyncDirectory(dir);
  if (process.platform === 'win32') {
    assert.equal(result.status, 'unsupported', 'Windows reports directory fsync as unsupported');
  } else {
    assert.equal(result.status, 'synced', 'POSIX reports directory fsync as synced');
  }
});

test('failure-injection: directory fsync permission failure propagates (POSIX)', async () => {
  const { fsyncDirectory } = await import('../lib/durability.cjs');
  const dir = path.dirname(tempFile());
  fs.mkdirSync(dir, { recursive: true });
  const mockFs = makeInjectableFs({
    openSync: (p, flags) => {
      if (flags === 'r') return 42;
      return require('node:fs').openSync(p, flags);
    },
    fsyncSync: (fd) => {
      if (fd === 42) {
        const err = Object.assign(new Error('mock permission failure'), { code: 'EPERM' });
        throw err;
      }
      return require('node:fs').fsyncSync(fd);
    },
    closeSync: (fd) => {
      if (fd === 42) return;
      return require('node:fs').closeSync(fd);
    },
  });
  if (process.platform === 'win32') {
    const result = fsyncDirectory(dir, mockFs);
    assert.equal(result.status, 'unsupported', 'Windows treats EPERM as unsupported');
  } else {
    assert.throws(() => fsyncDirectory(dir, mockFs), /cannot fsync directory/);
  }
});

// ---------------------------------------------------------------------------
// POSIX EROFS propagation
// ---------------------------------------------------------------------------

test('failure-injection: POSIX EROFS is propagated, not treated as unsupported', async () => {
  if (process.platform === 'win32') {
    // EROFS is not applicable on Windows.
    return;
  }
  const { fsyncDirectory, isKnownUnsupportedSyncError } = await import('../lib/durability.cjs');
  const dir = path.dirname(tempFile());
  fs.mkdirSync(dir, { recursive: true });
  // EROFS must not be classified as unsupported on POSIX.
  const erofsErr = Object.assign(new Error('EROFS'), { code: 'EROFS' });
  assert.equal(isKnownUnsupportedSyncError(erofsErr), false, 'EROFS must not be unsupported on POSIX');
  // And fsyncDirectory must propagate it.
  const mockFs = makeInjectableFs({
    openSync: (p, flags) => {
      if (flags === 'r') return 42;
      return require('node:fs').openSync(p, flags);
    },
    fsyncSync: (fd) => {
      if (fd === 42) {
        const err = Object.assign(new Error('mock read-only filesystem'), { code: 'EROFS' });
        throw err;
      }
      return require('node:fs').fsyncSync(fd);
    },
    closeSync: (fd) => {
      if (fd === 42) return;
      return require('node:fs').closeSync(fd);
    },
  });
  assert.throws(() => fsyncDirectory(dir, mockFs), /cannot fsync directory/);
});

// ---------------------------------------------------------------------------
// Journal deletion failure (clearPendingJournal)
// ---------------------------------------------------------------------------

test('failure-injection: journal deletion failure propagates', async () => {
  const { persistPendingEntry, clearPendingJournal, readPendingJournal } =
    await import('../lib/transaction-journal.cjs');
  const file = tempFile();
  const entry = basicEntry();
  persistPendingEntry(file, entry);
  const targetJournal = file + '.journal';
  const mockFs = makeInjectableFs({
    unlinkSync: (p) => {
      if (p === targetJournal) {
        throw new Error('mock journal deletion failure');
      }
      return require('node:fs').unlinkSync(p);
    },
  });
  assert.throws(
    () => clearPendingJournal(file, entry.operationId, entry.txHash, mockFs),
    /mock journal deletion failure/,
    'journal deletion failure must propagate'
  );
  // Journal must still exist after failed deletion.
  assert.equal(readPendingJournal(file).status, 'ok', 'journal preserved after deletion failure');
});

// ---------------------------------------------------------------------------
// Directory descriptor close failure (fsyncDirectory)
// ---------------------------------------------------------------------------

test('failure-injection: directory descriptor close failure propagates', async () => {
  const { fsyncDirectory } = await import('../lib/durability.cjs');
  const dir = path.dirname(tempFile());
  fs.mkdirSync(dir, { recursive: true });
  const mockFs = makeInjectableFs({
    openSync: (p, flags) => {
      if (flags === 'r') return 42;
      return require('node:fs').openSync(p, flags);
    },
    fsyncSync: (fd) => {
      if (fd === 42) return; // fsync succeeds
      return require('node:fs').fsyncSync(fd);
    },
    closeSync: (fd) => {
      if (fd === 42) {
        throw new Error('mock directory close failure');
      }
      return require('node:fs').closeSync(fd);
    },
  });
  assert.throws(() => fsyncDirectory(dir, mockFs), /cannot close directory descriptor/);
});

// ---------------------------------------------------------------------------
// Temp file cleanup failure after publish (persistPendingEntry)
// ---------------------------------------------------------------------------

test('failure-injection: temp cleanup failure after successful publish is reported', async () => {
  const { persistPendingEntry } = await import('../lib/transaction-journal.cjs');
  const file = tempFile();
  const entry = basicEntry();
  const mockFs = makeInjectableFs({
    unlinkSync: (p) => {
      if (p.includes('.tmp-')) {
        throw new Error('mock temp cleanup failure');
      }
      return require('node:fs').unlinkSync(p);
    },
  });
  // The journal is published but cleanup fails. The function throws.
  assert.throws(() => persistPendingEntry(file, entry, mockFs), /temporary file cleanup failed/);
  // But the journal exists on disk (publication succeeded).
  assert.equal(fs.existsSync(file + '.journal'), true, 'journal published despite cleanup failure');
});
