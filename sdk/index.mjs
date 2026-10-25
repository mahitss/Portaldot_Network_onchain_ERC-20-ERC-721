import { BrowserProvider, Contract, JsonRpcProvider } from 'ethers';
import { PotERC20ABI, PotERC721ABI, PotRegistryABI } from './abi.generated.mjs';
import {
  CHAIN_ID,
  CONVERSION_FACTOR,
  EVM_DECIMALS,
  KIND_ERC20,
  KIND_ERC721,
  NATIVE_ASSETS,
  NATIVE_DECIMALS,
  NATIVE_NFTS,
  RPC_URL,
  evmAddressToNativeAccount,
  evmToNative,
  formatAmount,
  nativeAccountHash,
  nativeToEvm,
  parseAmount,
} from '../shared/portaldot.mjs';

export {
  CHAIN_ID,
  CONVERSION_FACTOR,
  EVM_DECIMALS,
  KIND_ERC20,
  KIND_ERC721,
  NATIVE_ASSETS,
  NATIVE_DECIMALS,
  NATIVE_NFTS,
  RPC_URL,
  evmAddressToNativeAccount,
  evmToNative,
  formatAmount,
  nativeAccountHash,
  nativeToEvm,
  parseAmount,
};

export class PotTokenSuite {
  constructor({ provider, signer, addresses, deployments = null }) {
    this.provider = provider;
    this.signer = signer ?? null;
    this.addresses = addresses;
    this.deployments = deployments;

    const runner = this.signer ?? this.provider;
    this.erc20 = addresses.PotERC20 ? new Contract(addresses.PotERC20, PotERC20ABI, runner) : null;
    this.erc721 = addresses.PotERC721 ? new Contract(addresses.PotERC721, PotERC721ABI, runner) : null;
    this.registry = addresses.PotRegistry ? new Contract(addresses.PotRegistry, PotRegistryABI, runner) : null;
  }

  static async connect(options = {}) {
    const rpcUrl = options.rpcUrl ?? RPC_URL;
    const deployments = options.deployments ?? null;

    if (options.ethereum) {
      const browserProvider = new BrowserProvider(options.ethereum);
      const signer = options.useSigner === false ? null : await browserProvider.getSigner();
      return new PotTokenSuite({
        provider: browserProvider,
        signer,
        addresses: resolveAddresses(options, deployments),
        deployments,
      });
    }

    const provider = options.provider ?? new JsonRpcProvider(rpcUrl, options.chainId ?? CHAIN_ID);
    let signer = options.signer ?? null;
    if (!signer && options.privateKey) {
      const { Wallet } = await import('ethers');
      signer = new Wallet(options.privateKey, provider);
    }
    return new PotTokenSuite({
      provider,
      signer,
      addresses: resolveAddresses(options, deployments),
      deployments,
    });
  }

  async getNetworkInfo() {
    const network = await this.provider.getNetwork();
    const blockNumber = await this.provider.getBlockNumber();
    return { chainId: Number(network.chainId), blockNumber };
  }

  async getErc20State() {
    if (!this.erc20) {
      throw new Error('PotERC20 address is not configured');
    }
    const [name, symbol, decimals, totalSupply, owner, issuer, isPaused] = await Promise.all([
      this.erc20.name(),
      this.erc20.symbol(),
      this.erc20.decimals(),
      this.erc20.totalSupply(),
      this.erc20.owner(),
      this.erc20.issuer(),
      this.erc20.isPaused(),
    ]);
    return { name, symbol, decimals: Number(decimals), totalSupply, owner, issuer, isPaused };
  }

  async getErc721State() {
    if (!this.erc721) {
      throw new Error('PotERC721 address is not configured');
    }
    const [name, symbol, owner, issuer, totalSupply] = await Promise.all([
      this.erc721.name(),
      this.erc721.symbol(),
      this.erc721.owner(),
      this.erc721.issuer(),
      this.erc721.totalSupply(),
    ]);
    return { name, symbol, owner, issuer, totalSupply };
  }

  async getRegistryState() {
    if (!this.registry) {
      throw new Error('PotRegistry address is not configured');
    }
    const [owner, bindingCount] = await Promise.all([
      this.registry.owner(),
      this.registry.bindingCount(),
    ]);
    return { owner, bindingCount };
  }

  async getErc20Balance(holder) {
    return this.erc20.balanceOf(holder);
  }

  async getErc721Balance(holder) {
    return this.erc721.balanceOf(holder);
  }

  async getBinding(tokenAddress) {
    if (!this.registry) {
      throw new Error('PotRegistry address is not configured');
    }
    const binding = await this.registry.bindingOfToken(tokenAddress);
    return normalizeBinding(binding);
  }

  async isBound(tokenAddress) {
    return this.registry.isBound(tokenAddress);
  }

  async listBindings(tokenAddresses = []) {
    const bindings = [];
    for (const token of tokenAddresses) {
      if (await this.isBound(token)) {
        bindings.push(await this.getBinding(token));
      }
    }
    return bindings;
  }

  async convertToNative(bindingId, evmAmount) {
    return this.registry.convertToNative(bindingId, evmAmount);
  }

  async convertToEvm(bindingId, nativeAmount) {
    return this.registry.convertToEvm(bindingId, nativeAmount);
  }

  async verifyNativeAccount(bindingId, evmAddress) {
    const hash = await nativeAccountHash(evmAddress);
    const matches = await this.registry.verifyNativeAccount(bindingId, hash);
    return { hash, matches };
  }

  async mintErc20(to, amount) {
    return this.erc20.mint(to, amount);
  }

  async mintErc721(to, uri) {
    return this.erc721.mint(to, uri);
  }

  async bindToken({
    token,
    tokenKind,
    nativeKind,
    nativeId,
    nativeDecimals,
    evmDecimals,
    nativeAccountHash: hash,
  }) {
    return this.registry.bind(
      token,
      tokenKind,
      nativeKind,
      nativeId,
      nativeDecimals,
      evmDecimals,
      hash
    );
  }

  async unbind(bindingId) {
    return this.registry.unbind(bindingId);
  }

  async nativeAccountFor(evmAddress) {
    return evmAddressToNativeAccount(evmAddress);
  }
}

function resolveAddresses(options, deployments) {
  if (options.addresses) {
    return options.addresses;
  }
  if (deployments && deployments.contracts) {
    return {
      PotERC20: deployments.contracts.PotERC20?.address ?? null,
      PotERC721: deployments.contracts.PotERC721?.address ?? null,
      PotRegistry: deployments.contracts.PotRegistry?.address ?? null,
    };
  }
  return { PotERC20: null, PotERC721: null, PotRegistry: null };
}

function normalizeBinding(binding) {
  return {
    token: binding.token,
    tokenKind: Number(binding.tokenKind),
    nativeKind: Number(binding.nativeKind),
    nativeId: Number(binding.nativeId),
    nativeDecimals: Number(binding.nativeDecimals),
    evmDecimals: Number(binding.evmDecimals),
    conversionFactor: BigInt(binding.conversionFactor),
    nativeAccountHash: binding.nativeAccountHash,
    registeredAt: Number(binding.registeredAt),
    active: binding.active,
  };
}
