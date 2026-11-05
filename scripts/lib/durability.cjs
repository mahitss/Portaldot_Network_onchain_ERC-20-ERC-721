// Shared filesystem durability primitives.
//
// Used by persistence.cjs (writeJsonAtomic),
// transaction-journal.cjs (persistPendingEntry, persistTerminalFailure,
// clearPendingJournal), and any other module that publishes durable records
// atomically.
//
// Guarantees:
//   - Directory fsync is attempted after every atomic publication/rename,
//     but its result is reported, never silently swallowed.
//   - Directory descriptors are always closed, even when fsync fails.
//   - Unsupported directory fsync (platform/filesystem limitation) is
//     reported with status 'unsupported'; the atomic rename/link still
//     provides cross-crash visibility of which file exists.
//   - Real I/O and permission errors (EPERM on POSIX, EROFS on POSIX,
//     ENOSPC, EIO, etc.) are propagated as thrown errors; the caller must
//     treat the operation as not durably persisted.
//
// Platform differences:
//   - POSIX: directory fsync is supported; EPERM, EROFS, ENOSPC, EIO are
//     real failures and are propagated. EROFS is NOT treated as unsupported.
//   - Windows: the kernel rejects fsync on directory handles with EPERM;
//     directory fsync is not supported by the platform and is reported as
//     'unsupported'. Publication remains atomic via link/rename.
//
// Source: node:fs sync APIs (fs.openSync, fs.fsyncSync, fs.closeSync).

const fs = require('node:fs');

// Errors that mean "directory fsync is not supported on this platform".
// Permission failures and filesystem I/O errors are intentionally excluded:
// they are propagated as real durability failures.
function isKnownUnsupportedSyncError(error) {
  const code = error && error.code ? String(error.code) : '';
  if (process.platform === 'win32') {
    return (
      code === 'ENOTSUP' ||
      code === 'ENOSYS' ||
      code === 'EINVAL' ||
      code === 'EISDIR' ||
      code === 'EPERM'
    );
  }
  // POSIX: EROFS is a real read-only-filesystem failure, not an
  // unsupported operation. It must be propagated.
  return (
    code === 'ENOTSUP' ||
    code === 'ENOSYS' ||
    code === 'EINVAL' ||
    code === 'EISDIR'
  );
}

// Synchronize a directory's metadata to disk. Returns a status object and
// throws on real I/O / permission failures. The directory descriptor is
// always closed, even when fsync fails.
//
//   status 'synced' — directory fsync completed
//   status 'unsupported' — platform/filesystem does not support directory
//                          fsync; publication is still atomic but not
//                          fsync-durable across sudden power loss
function fsyncDirectory(directory, fs_ = fs) {
  let dirFd = null;
  try {
    dirFd = fs_.openSync(directory, 'r');
  } catch (error) {
    if (isKnownUnsupportedSyncError(error)) {
      return { status: 'unsupported', error: String(error.message || error) };
    }
    throw new Error(
      'cannot open directory for synchronization: ' +
        directory +
        ' (' +
        (error && error.message ? error.message : String(error)) +
        ')'
    );
  }
  try {
    fs_.fsyncSync(dirFd);
  } catch (error) {
    if (isKnownUnsupportedSyncError(error)) {
      return { status: 'unsupported', error: String(error.message || error) };
    }
    throw new Error(
      'cannot fsync directory: ' +
        directory +
        ' (' +
        (error && error.message ? error.message : String(error)) +
        ')'
    );
  } finally {
    if (dirFd !== null) {
      try {
        fs_.closeSync(dirFd);
      } catch (error) {
        throw new Error(
          'cannot close directory descriptor: ' +
            directory +
            ' (' +
            (error && error.message ? error.message : String(error)) +
            ')'
        );
      }
    }
  }
  return { status: 'synced', error: null };
}

// Report (never hide) when directory fsync is unsupported on this platform.
// Synced results are silent; unsupported results are written to stderr so
// operators know durability is best-effort on this platform.
function reportDirSync(result, context) {
  if (!result || result.status === 'synced') return;
  const reason = result && result.error ? result.error : 'unknown reason';
  const message =
    context +
    ': directory fsync unsupported on this platform (' +
    reason +
    '); publication succeeded but durability is not guaranteed across sudden power loss on filesystems that require explicit fsync.';
  if (
    typeof process !== 'undefined' &&
    process.stderr &&
    typeof process.stderr.write === 'function'
  ) {
    process.stderr.write('Warning: ' + message + '\n');
  }
}

module.exports = {
  isKnownUnsupportedSyncError,
  fsyncDirectory,
  reportDirSync,
};
