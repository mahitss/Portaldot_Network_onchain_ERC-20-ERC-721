// Shared file-based lock for release operations (deploy and bind).
//
// Uses atomic exclusive file creation (O_CREAT | O_EXCL via 'wx') so
// two processes cannot both acquire the same lock.  The lock file stores
// an ownership token (PID + timestamp + random nonce) so a process can
// only release the lock it actually acquired.
//
// Stale-lock recovery is MANUAL and fail-closed: a lock whose owner
// process is dead is reported, but the lock file is NOT automatically
// deleted.  The operator must inspect and remove it explicitly.
//
// Permissions: 0o600 where supported.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LOCK_MODE = 0o600;

function lockPathFor(recordFile) {
  return `${recordFile}.lock`;
}

function writeLockFile(lockPath, token) {
  const fd = fs.openSync(lockPath, 'wx', LOCK_MODE);
  try {
    fs.writeSync(fd, JSON.stringify(token));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // Best-effort chmod (may not be supported on all platforms).
  try {
    fs.chmodSync(lockPath, LOCK_MODE);
  } catch {
    // ignore
  }
}

function readLockFile(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.token !== 'string' ||
      typeof parsed.createdAt !== 'string'
    ) {
      return { status: 'malformed', data: null, error: 'lock file contents are not a valid ownership token' };
    }
    return { status: 'ok', data: parsed, error: null };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { status: 'missing', data: null, error: null };
    }
    return { status: 'malformed', data: null, error: error.message };
  }
}

function isProcessAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return { alive: false, reason: 'invalid-pid' };
  }
  try {
    process.kill(pid, 0);
    return { alive: true, reason: 'signalled' };
  } catch (error) {
    if (error.code === 'ESRCH') {
      return { alive: false, reason: 'esrch' };
    }
    if (error.code === 'EPERM') {
      return { alive: true, reason: 'eperm' };
    }
    return { alive: false, reason: error.code || 'unknown' };
  }
}

// Acquire a lock. Returns { acquired: true, token, release } on success.
// Throws on failure (lock held by live process, malformed lock, etc.).
function acquireLock(recordFile) {
  const lockPath = lockPathFor(recordFile);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const token = {
    pid: process.pid,
    token: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };

  // First attempt: exclusive creation.
  try {
    writeLockFile(lockPath, token);
    return {
      acquired: true,
      token,
      lockPath,
      release: () => releaseLock(lockPath, token),
    };
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw new Error(`cannot create lock file ${lockPath}: ${error.message}`);
    }
    // Lock file exists. Inspect it.
    const existing = readLockFile(lockPath);
    if (existing.status === 'missing') {
      // Race: file was deleted between EEXIST and read. Retry once.
      try {
        writeLockFile(lockPath, token);
        return { acquired: true, token, lockPath, release: () => releaseLock(lockPath, token) };
      } catch (retryError) {
        if (retryError.code === 'EEXIST') {
          throw new Error(`lock file ${lockPath} is held by another process; cannot acquire`);
        }
        throw new Error(`cannot create lock file ${lockPath}: ${retryError.message}`);
      }
    }
    if (existing.status === 'malformed') {
      // Fail closed: do not delete a malformed lock automatically.
      throw new Error(
        `lock file ${lockPath} is malformed (${existing.error}). ` +
          'For safety, the lock is not removed automatically. ' +
          'Inspect the file; if no release process is running, delete it manually and retry.'
      );
    }
    const owner = existing.data;
    const liveness = isProcessAlive(owner.pid);
    if (liveness.alive) {
      throw new Error(
        `another release process (PID ${owner.pid}) is already running (lock created ${owner.createdAt}). ` +
          'Refusing to start a concurrent release. ' +
          'If that process is no longer running, inspect and manually remove the lock file: ' + lockPath
      );
    }
    // Process is dead (ESRCH). Still fail closed — do not auto-delete.
    throw new Error(
      `lock file ${lockPath} exists but its owner (PID ${owner.pid}) is not running. ` +
        'This may be a stale lock from a crashed process. ' +
        'Verify no other release is in progress, then manually remove the lock file and retry: ' + lockPath
    );
  }
}

function releaseLock(lockPath, token) {
  const existing = readLockFile(lockPath);
  if (existing.status === 'missing') {
    return; // already removed
  }
  if (existing.status === 'malformed') {
    // Do not delete a malformed lock — it may belong to another process.
    return;
  }
  // Only release if the token matches.
  if (existing.data.token !== token.token || existing.data.pid !== token.pid) {
    // Not our lock — do not delete.
    return;
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // best-effort
  }
}

module.exports = {
  LOCK_MODE,
  lockPathFor,
  acquireLock,
  releaseLock,
  readLockFile,
  isProcessAlive,
};