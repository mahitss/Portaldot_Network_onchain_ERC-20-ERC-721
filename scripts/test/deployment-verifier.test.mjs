import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { verifyArtifactRuntimeCode } = await import(
  pathToFileURL(path.join(root, 'scripts', 'lib', 'deployment-verifier.cjs')).href
);

const ERC20_ARTIFACT = path.join(root, 'artifacts', 'contracts', 'PotERC20.sol', 'PotERC20.json');
const ERC721_ARTIFACT = path.join(root, 'artifacts', 'contracts', 'PotERC721.sol', 'PotERC721.json');
const REGISTRY_ARTIFACT = path.join(root, 'artifacts', 'contracts', 'PotRegistry.sol', 'PotRegistry.json');

function deployedBytecodeOf(artifactPath) {
  return JSON.parse(fs.readFileSync(artifactPath, 'utf8')).deployedBytecode;
}

test('deployment-verifier: exact-match path accepts correct runtime bytecode for each contract', () => {
  for (const artifact of [ERC20_ARTIFACT, ERC721_ARTIFACT, REGISTRY_ARTIFACT]) {
    const code = deployedBytecodeOf(artifact);
    const result = verifyArtifactRuntimeCode('PotContract', artifact, code);
    assert.equal(result.method, 'exact');
    assert.equal(result.bytes, (code.length - 2) / 2);
  }
});

test('deployment-verifier: exact-match path rejects wrong runtime bytecode', () => {
  const wrongCode = '0x' + 'ff'.repeat(200);
  assert.throws(() => verifyArtifactRuntimeCode('PotERC20', ERC20_ARTIFACT, wrongCode), /does not match the compiled artifact/);
});

test('deployment-verifier: missing runtime bytecode (0x) is rejected', () => {
  assert.throws(() => verifyArtifactRuntimeCode('PotERC20', ERC20_ARTIFACT, '0x'), /no bytecode exists|does not match/);
});

test('deployment-verifier: empty runtime bytecode is rejected', () => {
  assert.throws(() => verifyArtifactRuntimeCode('PotERC20', ERC20_ARTIFACT, ''), /no bytecode exists|does not match/);
});

test('deployment-verifier: length mismatch is rejected even outside patch regions', () => {
  const code = deployedBytecodeOf(ERC20_ARTIFACT) + 'deadbeef';
  assert.throws(() => verifyArtifactRuntimeCode('PotERC20', ERC20_ARTIFACT, code), /does not match the compiled artifact/);
});

test('deployment-verifier: mismatch inside a non-patch region is rejected', () => {
  // Flip a byte early in the code (well before any plausible patch region).
  const code = deployedBytecodeOf(ERC20_ARTIFACT).replace(/^0x6080/, '0x6081');
  assert.throws(() => verifyArtifactRuntimeCode('PotERC20', ERC20_ARTIFACT, code), /does not match the compiled artifact/);
});

test('deployment-verifier: fabricating an artifact with link references fails closed when offsets are unavailable', async () => {
  const artifact = {
    _format: 'json',
    contractName: 'Fake',
    sourceName: 'contracts/Fake.sol',
    abi: [],
    bytecode: '0x6080604052',
    deployedBytecode: '0x6080604052',
    linkReferences: { 'contracts/Fake.sol:Fake': { Lib: [] } },
    deployedLinkReferences: { 'contracts/Fake.sol:Fake': { Lib: [] } },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-'));
  const file = path.join(dir, 'Fake.json');
  fs.writeFileSync(file, JSON.stringify(artifact));
  // The artifact reports link references but provides no usable patch offsets,
  // so verification must fail closed rather than guess.
  assert.throws(() => verifyArtifactRuntimeCode('Fake', file, '0x6080604052'), /not possible|manual inspection/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('deployment-verifier: fabricating an artifact with immutables fails closed when offsets are unavailable', async () => {
  const artifact = {
    _format: 'json',
    contractName: 'Fake',
    sourceName: 'contracts/Fake.sol',
    abi: [],
    bytecode: '0x6080604052',
    deployedBytecode: '0x6080604052',
    immutables: [{ name: 'x', offset: 2, length: 32 }],
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-'));
  const file = path.join(dir, 'Fake2.json');
  fs.writeFileSync(file, JSON.stringify(artifact));
  assert.throws(() => verifyArtifactRuntimeCode('Fake', file, '0x6080604052'), /not possible|manual inspection/);
  fs.rmSync(dir, { recursive: true, force: true });
});
