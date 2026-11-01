// Shared journal recovery gate for release operations.
//
// This module provides a single, authoritative check that must run
// immediately after acquiring the release lock and before ANY release
// operation (fresh, resumed, or forced).  It ensures that an unresolved
// journal is never bypassed by any code path.
//
// Usage:
//   const gate = checkJournalGate(recordFile, recordIo);
//   if (gate.blocked) throw new Error(gate.reason);

const fs = require('node:fs');
const path = require('node:path');
const { readJsonRecord } = require('./persistence.cjs');
const { readPendingJournal } = require('./transaction-journal.cjs');

const JOURNAL_SCHEMA_VERSION = 1;

function checkJournalGate(recordFile, recordIo) {
  const journalResult = readPendingJournal(recordFile);

  // No journal → gate is open.
  if (journalResult.status === 'missing') {
    return { blocked: false, journal: null, reason: null };
  }

  // Malformed journal → fail closed.
  if (journalResult.status === 'malformed') {
    return {
      blocked: true,
      journal: null,
      reason:
        `the transaction journal at ${recordFile}.journal is malformed (${journalResult.error}). ` +
        'Refusing to proceed. Inspect and resolve the journal manually before retrying.',
    };
  }

  const journal = journalResult.entry;

  // Validate schema version.
  if (journal.schemaVersion !== undefined && journal.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
    return {
      blocked: true,
      journal: null,
      reason:
        `the transaction journal has unsupported schema version ${journal.schemaVersion} (expected ${JOURNAL_SCHEMA_VERSION}). ` +
        'Refusing to proceed. Resolve the journal manually.',
    };
  }

  // Validate required fields.
  if (!journal.txHash || !journal.operation || !journal.signed) {
    return {
      blocked: true,
      journal: null,
      reason:
        'the transaction journal is incomplete (missing txHash, operation, or signed bytes). ' +
        'Refusing to proceed. Resolve the journal manually.',
    };
  }

  // Check the deployment record.
  const recordResult = recordIo.read(recordFile);

  if (recordResult.status === 'missing') {
    return {
      blocked: true,
      journal,
      reason:
        `an unresolved transaction journal exists (txHash: ${journal.txHash}, operation: ${journal.operation}) ` +
        'but no deployment record was found. This indicates a crash between journal and record persistence. ' +
        'Inspect the journal file and reconcile manually before retrying. Do not start a new release.',
    };
  }

  if (recordResult.status === 'malformed') {
    return {
      blocked: true,
      journal,
      reason:
        `an unresolved transaction journal exists (txHash: ${journal.txHash}) ` +
        `but the deployment record is malformed (${recordResult.error}). ` +
        'Refusing to proceed. Resolve the record or journal manually before retrying.',
    };
  }

  const record = recordResult.data;

  // Validate that the journal matches a pending entry in the record.
  let matched = false;
  const contracts = record.contracts || {};
  for (const [name, entry] of Object.entries(contracts)) {
    if (entry && entry.status === 'pending' && entry.txHash === journal.txHash) {
      matched = true;
      break;
    }
  }
  // Also check bindings.
  if (!matched && Array.isArray(record.bindings)) {
    for (const entry of record.bindings) {
      if (entry && entry.status === 'pending' && entry.txHash === journal.txHash) {
        matched = true;
        break;
      }
    }
  }

  if (!matched) {
    return {
      blocked: true,
      journal,
      reason:
        `an unresolved transaction journal exists (txHash: ${journal.txHash}, operation: ${journal.operation}) ` +
        'but no matching pending entry was found in the deployment record. ' +
        'Inspect the journal and record; reconcile manually before retrying.',
    };
  }

  // Journal and record are consistent. Gate is open for recovery.
  return { blocked: false, journal, reason: null };
}

module.exports = {
  JOURNAL_SCHEMA_VERSION,
  checkJournalGate,
};