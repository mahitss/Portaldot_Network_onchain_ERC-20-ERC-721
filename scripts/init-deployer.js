const fs = require('node:fs');
const path = require('node:path');
const { Wallet } = require('ethers');

const root = path.resolve(__dirname, '..');
const envPath = path.join(root, '.env');

async function main() {
  const { evmAddressToNativeAccount } = await import(
    `file://${path.join(root, 'shared', 'portaldot.mjs').replace(/\\/g, '/')}`
  );

  if (fs.existsSync(envPath) && process.env.POT_FORCE_NEW_DEPLOYER !== '1') {
    const existing = fs
      .readFileSync(envPath, 'utf8')
      .split('\n')
      .find((line) => line.startsWith('PORTALDOT_DEPLOYER_PRIVATE_KEY='));
    if (existing) {
      const key = existing.split('=')[1].trim();
      const wallet = new Wallet(key);
      const account = evmAddressToNativeAccount(wallet.address);
      process.stdout.write(`existing deployer\n`);
      process.stdout.write(`evm address  ${wallet.address}\n`);
      process.stdout.write(`native ss58  ${account.ss58}\n`);
      process.stdout.write(`account hex  ${account.hex}\n`);
      return;
    }
  }

  const wallet = Wallet.createRandom();
  const account = evmAddressToNativeAccount(wallet.address);
  const line = `PORTALDOT_DEPLOYER_PRIVATE_KEY=${wallet.privateKey}`;

  if (fs.existsSync(envPath)) {
    const content = fs
      .readFileSync(envPath, 'utf8')
      .split('\n')
      .filter((entry) => !entry.startsWith('PORTALDOT_DEPLOYER_PRIVATE_KEY='))
      .join('\n');
    fs.writeFileSync(envPath, `${content.replace(/\n*$/, '')}\n${line}\n`);
  } else {
    fs.writeFileSync(envPath, `${line}\n`);
  }

  process.stdout.write(`deployer key written to .env (gitignored)\n`);
  process.stdout.write(`evm address  ${wallet.address}\n`);
  process.stdout.write(`native ss58  ${account.ss58}\n`);
  process.stdout.write(`account hex  ${account.hex}\n`);
  process.stdout.write(`\nfund the native account with at least 1050 tPOT, then run npm run deploy:testnet\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
