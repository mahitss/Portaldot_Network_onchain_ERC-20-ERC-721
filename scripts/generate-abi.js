const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ARTIFACTS = [
  ['PotERC20', 'contracts/PotERC20.sol/PotERC20.json'],
  ['PotERC721', 'contracts/PotERC721.sol/PotERC721.json'],
  ['PotRegistry', 'contracts/PotRegistry.sol/PotRegistry.json'],
];

const root = path.resolve(__dirname, '..');
const output = [];

for (const [name, relative] of ARTIFACTS) {
  const artifactPath = path.join(root, 'artifacts', relative);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`artifact missing: ${relative}. run npm run compile first`);
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  output.push(`export const ${name}ABI = ${JSON.stringify(artifact.abi)};`);
}

const target = path.join(root, 'sdk', 'abi.generated.mjs');
fs.writeFileSync(target, `${output.join('\n')}\n`);
process.stdout.write(`wrote ${path.relative(root, target)}\n`);
