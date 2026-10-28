import { JsonRpcProvider } from 'ethers';
import { PotTokenSuite } from '../sdk/index.mjs';
import {
  CHAIN_ID,
  EVM_DECIMALS,
  NATIVE_DECIMALS,
  RPC_URL,
  escapeHtml,
  evmAddressToNativeAccount,
  evmToNative,
  formatAmount,
  nativeAccountHash,
  nativeToEvm,
  parseAmount,
} from '../shared/portaldot.mjs';

const state = { provider: null, suite: null, deployments: null };

function render(target, entries) {
  const node = document.getElementById(target);
  node.innerHTML = entries
    .map(
      ([label, value]) =>
        `<div class="row"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(
          value
        )}</span></div>`
    )
    .join('');
}

async function loadDeployments() {
  try {
    const response = await fetch('../deployments/portaldotTestnet.json', { cache: 'no-store' });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  }
}

async function refreshChain() {
  try {
    const network = await state.provider.getNetwork();
    const blockNumber = await state.provider.getBlockNumber();
    document.getElementById('network').textContent = `chain ${Number(network.chainId)} block ${blockNumber}`;
    render('chain-status', [
      ['rpc endpoint', RPC_URL],
      ['chain id', String(Number(network.chainId))],
      ['expected chain id', String(CHAIN_ID)],
      ['latest block', String(blockNumber)],
    ]);
  } catch (error) {
    document.getElementById('network').textContent = 'rpc unreachable from the browser';
    render('chain-status', [['rpc error', error.message]]);
  }
}

async function refreshContracts() {
  const contracts = state.deployments?.contracts ?? {};
  const entries = [];
  for (const [name, entry] of Object.entries(contracts)) {
    let code = '0x';
    try {
      code = await state.provider.getCode(entry.address);
    } catch {
      code = '0x';
    }
    entries.push([name, `${entry.address} (${Math.max(0, code.length / 2 - 1)} bytes)`]);
  }
  if (entries.length === 0) {
    entries.push(['status', 'no deployment file found, deploy first']);
  }
  render('contract-status', entries);
}

async function refreshTokens() {
  if (!state.deployments) {
    render('token-state', [['status', 'no deployment file found']]);
    return;
  }
  const entries = [];
  try {
    const erc20 = await state.suite.getErc20State();
    entries.push(['erc20 name', erc20.name]);
    entries.push(['erc20 symbol', erc20.symbol]);
    entries.push(['erc20 decimals', String(erc20.decimals)]);
    entries.push(['erc20 supply', formatAmount(erc20.totalSupply, erc20.decimals)]);
    entries.push(['erc20 owner', erc20.owner]);
    entries.push(['erc20 issuer', erc20.issuer]);
    entries.push(['erc20 paused', String(erc20.isPaused)]);
  } catch (error) {
    entries.push(['erc20 error', error.message]);
  }
  try {
    const erc721 = await state.suite.getErc721State();
    entries.push(['erc721 name', erc721.name]);
    entries.push(['erc721 symbol', erc721.symbol]);
    entries.push(['erc721 supply', String(erc721.totalSupply)]);
    entries.push(['erc721 owner', erc721.owner]);
  } catch (error) {
    entries.push(['erc721 error', error.message]);
  }
  try {
    const registry = await state.suite.getRegistryState();
    entries.push(['registry owner', registry.owner]);
    entries.push(['registry bindings', String(registry.bindingCount)]);
  } catch (error) {
    entries.push(['registry error', error.message]);
  }
  render('token-state', entries);
}

async function refreshBindings() {
  const tokens = Object.entries(state.deployments?.tokens ?? {});
  const entries = [];
  for (const [label, token] of tokens) {
    try {
      const bound = await state.suite.isBound(token.address);
      if (!bound) {
        entries.push([label, `${token.address} not bound`]);
        continue;
      }
      const binding = await state.suite.getBinding(token.address);
      entries.push([`${label} token`, binding.token]);
      entries.push([`${label} native kind`, String(binding.nativeKind)]);
      entries.push([`${label} native id`, String(binding.nativeId)]);
      entries.push([`${label} decimals`, `${binding.nativeDecimals} native to ${binding.evmDecimals} evm`]);
      entries.push([`${label} factor`, binding.conversionFactor.toString()]);
      entries.push([`${label} account hash`, binding.nativeAccountHash]);
    } catch (error) {
      entries.push([`${label} error`, error.message]);
    }
  }
  if (entries.length === 0) {
    entries.push(['status', 'no bindings to show']);
  }
  render('binding-result', entries);
}

document.getElementById('mapping-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = document.getElementById('evm-address').value.trim();
  try {
    const account = evmAddressToNativeAccount(value);
    const rows = [
      ['evm address', account.evmAddress],
      ['native ss58', account.ss58],
      ['native account bytes', account.hex],
      ['suffix byte', `0x${account.bytes[20].toString(16).padStart(2, '0')} repeated 12 times`],
    ];
    render('mapping-result', rows);
    nativeAccountHash(value)
      .then((hash) => {
        rows.push(['sha256 commitment', hash]);
        render('mapping-result', rows);
      })
      .catch((error) => {
        rows.push(['sha256 commitment', `error: ${error.message}`]);
        render('mapping-result', rows);
      });
  } catch (error) {
    render('mapping-result', [['error', error.message]]);
  }
});

document.getElementById('conversion-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const raw = document.getElementById('amount').value.trim();
  try {
    const asNative = parseAmount(raw, NATIVE_DECIMALS);
    const asEvm = parseAmount(raw, EVM_DECIMALS);
    render('conversion-result', [
      ['input', raw],
      [`${NATIVE_DECIMALS} decimals to evm`, `${formatAmount(nativeToEvm(asNative), EVM_DECIMALS)} (${nativeToEvm(asNative)} wei)`],
      [`${EVM_DECIMALS} decimals to native`, `${formatAmount(evmToNative(asEvm), NATIVE_DECIMALS)} (${evmToNative(asEvm)} native units)`],
      ['conversion factor', '10000'],
    ]);
  } catch (error) {
    render('conversion-result', [['error', error.message]]);
  }
});

document.getElementById('balance-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const holder = document.getElementById('holder').value.trim();
  const rows = [['holder', holder]];
  try {
    const balance = await state.suite.getErc20Balance(holder);
    rows.push(['erc20 balance', formatAmount(balance, EVM_DECIMALS)]);
    rows.push(['erc20 raw', balance.toString()]);
  } catch (error) {
    rows.push(['erc20 error', error.message]);
  }
  try {
    const balance = await state.suite.getErc721Balance(holder);
    rows.push(['erc721 balance', balance.toString()]);
  } catch (error) {
    rows.push(['erc721 error', error.message]);
  }
  render('balance-result', rows);
});

async function init() {
  state.deployments = await loadDeployments();
  state.provider = new JsonRpcProvider(RPC_URL, CHAIN_ID);
  state.suite = await PotTokenSuite.connect({ provider: state.provider, deployments: state.deployments });
  await refreshChain();
  await refreshContracts();
  await refreshTokens();
  await refreshBindings();
}

init().catch((error) => {
  document.getElementById('network').textContent = `console error: ${error.message}`;
});
