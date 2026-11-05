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
  const bytecode = '0x6080604052' + '00'.repeat(40);
  const bytecodeLen = (bytecode.length - 2) / 2;
  // offset + length exceeds bytecode length → offsets are unavailable/malformed
  const artifact = {
    _format: 'json',
    contractName: 'Fake',
    sourceName: 'contracts/Fake.sol',
    abi: [],
    bytecode,
    deployedBytecode: bytecode,
    immutables: [{ name: 'x', offset: bytecodeLen, length: 32 }],
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-'));
  const file = path.join(dir, 'Fake2.json');
  fs.writeFileSync(file, JSON.stringify(artifact));
  assert.throws(() => verifyArtifactRuntimeCode('Fake', file, bytecode), /out-of-range|out of bounds|refusing to verify/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Synthetic patch-region tests ---

// Build a synthetic artifact from a real deployedBytecode with optional
// immutable and link-reference patch metadata.
function syntheticArtifact(deployedBytecode, immutables, linkRefs) {
  return {
    _format: 'json',
    contractName: 'Fake',
    sourceName: 'contracts/Fake.sol',
    abi: [],
    bytecode: deployedBytecode,
    deployedBytecode,
    ...(immutables ? { immutables } : {}),
    ...(linkRefs ? { linkReferences: { 'contracts/Fake.sol:Fake': linkRefs }, deployedLinkReferences: { 'contracts/Fake.sol:Fake': linkRefs } } : {}),
  };
}

function writeSyntheticArtifact(artifact) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-'));
  const file = path.join(dir, 'Fake.json');
  fs.writeFileSync(file, JSON.stringify(artifact));
  return { dir, file };
}

const BASE_CODE = deployedBytecodeOf(ERC20_ARTIFACT);

test('deployment-verifier: valid immutable offset patch skips the patched region', async () => {
  const patchStart = 10;
  const patchLen = 4;
  const artifact = syntheticArtifact(BASE_CODE, [{ offset: patchStart, length: patchLen }], null);
  const { file, dir } = writeSyntheticArtifact(artifact);
  try {
    // Actual code differs from the artifact ONLY inside the patch region.
    const actualBytes = Buffer.from(BASE_CODE.slice(2), 'hex');
    actualBytes[patchStart] = 0xaa; // differ inside patch
    actualBytes[patchStart + 1] = 0xbb; // differ inside patch
    const actual = '0x' + actualBytes.toString('hex');
    const result = verifyArtifactRuntimeCode('Fake', file, actual);
    assert.equal(result.method, 'patched-immutables');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deployment-verifier: valid library-link offset patch skips the patched region', async () => {
  const patchStart = 20;
  const patchLen = 20;
  const artifact = syntheticArtifact(BASE_CODE, null, { Lib: [{ start: patchStart, length: patchLen }] });
  const { file, dir } = writeSyntheticArtifact(artifact);
  try {
    // Actual code differs from the artifact ONLY inside the link-reference patch region.
    const actualBytes = Buffer.from(BASE_CODE.slice(2), 'hex');
    actualBytes[patchStart] = 0xcc;
    const actual = '0x' + actualBytes.toString('hex');
    const result = verifyArtifactRuntimeCode('Fake', file, actual);
    assert.equal(result.method, 'patched-link-references');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deployment-verifier: both immutable and link-reference patches present together', async () => {
  const immStart = 10;
  const immLen = 4;
  const linkStart = 50;
  const linkLen = 20;
  const artifact = syntheticArtifact(
    BASE_CODE,
    [{ offset: immStart, length: immLen }],
    { Lib: [{ start: linkStart, length: linkLen }], Other: [{ start: 80, length: 8 }] }
  );
  const { file, dir } = writeSyntheticArtifact(artifact);
  try {
    const actualBytes = Buffer.from(BASE_CODE.slice(2), 'hex');
    actualBytes[immStart] = 0x11; // inside immutable patch
    actualBytes[linkStart] = 0x22; // inside link-reference patch
    actualBytes[80] = 0x33; // inside second link-reference patch
    const actual = '0x' + actualBytes.toString('hex');
    const result = verifyArtifactRuntimeCode('Fake', file, actual);
    assert.equal(result.method, 'patched-immutables+link-references');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deployment-verifier: out-of-range immutable offset is rejected', async () => {
  const bytecodeLen = (BASE_CODE.length - 2) / 2;
  const artifact = syntheticArtifact(BASE_CODE, [{ offset: bytecodeLen, length: 1 }], null);
  const { file, dir } = writeSyntheticArtifact(artifact);
  try {
    assert.throws(() => verifyArtifactRuntimeCode('Fake', file, BASE_CODE), /out-of-range|out of bounds|refusing to verify/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deployment-verifier: malformed immutable offset (non-integer) is rejected', async () => {
  const artifact = syntheticArtifact(BASE_CODE, [{ offset: 'not-a-number', length: 4 }], null);
  const { file, dir } = writeSyntheticArtifact(artifact);
  try {
    assert.throws(() => verifyArtifactRuntimeCode('Fake', file, BASE_CODE), /malformed|refusing to verify/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deployment-verifier: negative immutable offset is rejected', async () => {
  const artifact = syntheticArtifact(BASE_CODE, [{ offset: -1, length: 4 }], null);
  const { file, dir } = writeSyntheticArtifact(artifact);
  try {
    assert.throws(() => verifyArtifactRuntimeCode('Fake', file, BASE_CODE), /malformed|refusing to verify/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deployment-verifier: zero-length patch is rejected', async () => {
  const artifact = syntheticArtifact(BASE_CODE, [{ offset: 10, length: 0 }], null);
  const { file, dir } = writeSyntheticArtifact(artifact);
  try {
    assert.throws(() => verifyArtifactRuntimeCode('Fake', file, BASE_CODE), /malformed|refusing to verify/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deployment-verifier: wrong patch length leaves bytes outside patch unverified', async () => {
  // Declare a 1-byte patch but the actual code differs at byte 11, which is
  // outside the 1-byte patch region (offset 10, length 1 covers only byte 10).
  const artifact = syntheticArtifact(BASE_CODE, [{ offset: 10, length: 1 }], null);
  const { file, dir } = writeSyntheticArtifact(artifact);
  try {
    const actualBytes = Buffer.from(BASE_CODE.slice(2), 'hex');
    actualBytes[10] = 0xaa; // inside the 1-byte patch - skipped
    actualBytes[11] = 0xbb; // outside the patch - must be caught
    const actual = '0x' + actualBytes.toString('hex');
    assert.throws(() => verifyArtifactRuntimeCode('Fake', file, actual), /mismatch at byte offset/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deployment-verifier: overlapping patch ranges are rejected', async () => {
  const artifact = syntheticArtifact(
    BASE_CODE,
    [{ offset: 10, length: 20 }],
    { Lib: [{ start: 15, length: 20 }] }
  );
  const { file, dir } = writeSyntheticArtifact(artifact);
  try {
    assert.throws(() => verifyArtifactRuntimeCode('Fake', file, BASE_CODE), /overlap|refusing to verify/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

