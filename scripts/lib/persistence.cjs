// Atomic file persistence for deployment records and related JSON state.
// Every write is replace-atomic (temporary file in the same directory, then
// rename), so an interrupted run can never leave a half-written record.

const fs = require('node:fs');
const path = require('node:path');

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

function writeJsonAtomic(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${writeCounter++}`;
  // Write the temporary file and fsync it before the atomic rename so an
  // interrupted run never leaves a half-written replacement visible.
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    const data = `${JSON.stringify(value, null, 2)}\n`;
    let written = 0;
    while (written < data.length) {
      const n = fs.writeSync(fd, data, written);
      if (n <= 0) throw new Error('failed to write full record payload');
      written += n;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // the tmp file is best-effort removed; the original record is intact
    }
    throw new Error(`atomic record write failed for ${file}: ${error.message}`);
  }
  // Best-effort directory fsync so the rename is durable where supported.
  // Not all filesystems/platforms support directory fsync; failure here is
  // not fatal but the file is valid once the rename completes.
  try {
    const dirFd = fs.openSync(directory, 'r');
    fs.fsyncSync(dirFd);
    fs.closeSync(dirFd);
  } catch {
    // directory fsync unsupported; rename still provides atomic visibility
  }
}

// Archive an existing record next to itself before a deliberate fresh
// release. Never deletes anything; returns the archive path or null.
function archiveRecord(file) {
  if (!fs.existsSync(file)) {
    return null;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archive = `${file}.pre-${stamp}`;
  fs.copyFileSync(file, archive);
  return archive;
}

module.exports = { readJsonRecord, writeJsonAtomic, archiveRecord };
