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
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
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
