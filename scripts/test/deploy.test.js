import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { validateContractArtifact, validateChainId } from '../deploy.js';

const root = path.resolve(__dirname, '..');

test('validateContractArtifact accepts valid contract artifact', () => {
  const artifactPath = path.join(root, 'artifacts', 'contracts', 'PotERC20.sol', 'PotERC20.json');
  const runtimeBytes = validateContractArtifact(artifactPath, 10240);
  assert.ok(runtimeBytes > 0);
  assert.ok(runtimeBytes <= 10240);
});

test('validateContractArtifact rejects oversized bytecode', () => {
  const artifactPath = path.join(root, 'artifacts', 'contracts', 'PotERC20.sol', 'PotERC20.json');
  assert.throws(() => validateContractArtifact(artifactPath, 1), /exceeds/);
});

test('validateChainId accepts correct chain ID', () => {
  assert.doesNotThrow(() => validateChainId(420420777, 420420777));
});

test('validateChainId rejects wrong chain ID', () => {
  assert.throws(() => validateChainId(1, 420420777), /wrong chain ID/);
  assert.throws(() => validateChainId(0, 420420777), /wrong chain ID/);
});
