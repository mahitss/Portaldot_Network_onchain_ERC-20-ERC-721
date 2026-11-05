// Atomic file persistence for deployment records and related JSON state.
// Every write is replace-atomic (temporary file in the same directory, then
// rename), so an interrupted run can never leave a half-written record.
//
// Directory synchronization uses the shared durability module
// (./durability.cjs). Directory fsync results are reported, never silently
// swallowed:
//   - 'synced'     — directory fsync completed; the rename is durable
//   - 'unsupported' — platform/filesystem does not support directory fsync
//                      (e.g. Windows); the atomic rename still provides
//                      cross-crash visibility, but fsync-level durability
//                      is best-effort
//   - thrown error — real I/O or permission failure (POSIX EPERM, EROFS,
//                    ENOSPC, EIO); the operation is NOT durably persisted

const fs = require('node:fs');
const path = require('node:path');
const { fsyncDirectory, reportDirSync } = require('./durability.cjs');

function readJsonRecord(file) {
  if (!fs.existsSync(file)) {
    return { status: 'missing', data: null, error: null };
  }
  try {
    return { status: 'ok', data: JSON.parse(fs.readFileSync(file, 'utf8')), error: null };
  } catch (error) {
    return { status: 'malformed', data: null, error: error.message };
  }
}

let writeCounter = 0;

function writeJsonAtomic(file, value, fs_ = fs) {
  const directory = path.dirname(file);
  fs_.mkdirSync(directory, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${writeCounter++}`;
  // Write the temporary file and fsync it before the atomic rename so an
  // interrupted run never leaves a half-written replacement visible.
  const fd = fs_.openSync(tmp, 'w', 0o600);
  try {
    const data = `${JSON.stringify(value, null, 2)}\n`;
    let written = 0;
    while (written < data.length) {
      const n = fs_.writeSync(fd, data, written);
      if (n <= 0) throw new Error('failed to write full record payload');
      written += n;
    }
    fs_.fsyncSync(fd);
  } catch (error) {
    let closeError = null;
    try { fs_.closeSync(fd); } catch (e) { closeError = e; }
    let unlinkError = null;
    try { fs_.unlinkSync(tmp); } catch (e) { unlinkError = e; }
    let message = 'atomic record write failed for ' + file + ': ' + error.message;
    if (closeError !== null) message += '. close also failed: ' + closeError.message;
    if (unlinkError !== null) message += '. cleanup also failed: ' + unlinkError.message;
    throw new Error(message);
  }
  try {
    fs_.closeSync(fd);
  } catch (error) {
    try { fs_.unlinkSync(tmp); } catch { /* cleanup aggregated below */ }
    throw new Error(
      'cannot close temporary record file ' + tmp + ': ' + error.message +
      '; publication aborted to avoid incomplete record'
    );
  }
  try {
    fs_.renameSync(tmp, file);
  } catch (error) {
    try { fs_.unlinkSync(tmp); } catch { /* cleanup failure aggregated below */ }
    throw new Error('atomic record write failed for ' + file + ': ' + error.message);
  }
  // Directory fsync makes the rename durable. Report the result; never
  // swallow a real filesystem error.
  const syncResult = fsyncDirectory(directory, fs_);
  reportDirSync(syncResult, 'record written');
  // Return the sync status so callers can distinguish durable vs best-effort.
  return { status: syncResult.status, error: syncResult.error, file };
}

// Archive an existing record next to itself before a deliberate fresh
// release. Never deletes anything; returns the archive path or null.
function archiveRecord(file, fs_ = fs) {
  if (!fs_.existsSync(file)) {
    return null;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archive = `${file}.pre-${stamp}`;
  fs_.copyFileSync(file, archive);
  return archive;
}

module.exports = { readJsonRecord, writeJsonAtomic, archiveRecord };
