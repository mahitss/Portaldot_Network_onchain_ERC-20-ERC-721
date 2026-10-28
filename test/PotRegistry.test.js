const assert = require('node:assert/strict');
const { expect } = require('chai');
const { ethers } = require('hardhat');

const ZERO = '0x0000000000000000000000000000000000000000';

describe('PotRegistry', function () {
  async function deploy() {
    const [owner, alice] = await ethers.getSigners();
    const registryFactory = await ethers.getContractFactory('PotRegistry');
    const registry = await registryFactory.deploy();
    await registry.waitForDeployment();
    const erc20Factory = await ethers.getContractFactory('PotERC20');
    const erc20 = await erc20Factory.deploy('Registry Test Token', 'RTT', owner.address);
    await erc20.waitForDeployment();
    const erc721Factory = await ethers.getContractFactory('PotERC721');
    const erc721 = await erc721Factory.deploy('Registry Test Collection', 'RTC', owner.address);
    await erc721.waitForDeployment();
    return {
      registry,
      owner,
      alice,
      erc20: await erc20.getAddress(),
      erc721: await erc721.getAddress(),
    };
  }

  const nativeAccountHash = '0x' + 'ab'.repeat(32);

  it('constructor sets owner and empty state', async function () {
    const { registry, owner } = await deploy();
    assert.equal(await registry.owner(), owner.address);
    assert.equal(await registry.bindingCount(), 0n);
  });

  it('binds an ERC-20 to a native asset with the unit conversion factor', async function () {
    const { registry, owner, erc20 } = await deploy();
    await expect(
      registry.connect(owner).bind(erc20, 0, 1, 4401, 14, 18, nativeAccountHash)
    )
      .to.emit(registry, 'TokenBound')
      .withArgs(1n, erc20, 0n, 1n, 4401n, 14n, 18n, 10000n, nativeAccountHash);

    const binding = await registry.bindingOf(1n);
    assert.equal(binding.token, erc20);
    assert.equal(Number(binding.tokenKind), 0);
    assert.equal(Number(binding.nativeKind), 1);
    assert.equal(Number(binding.nativeId), 4401);
    assert.equal(Number(binding.nativeDecimals), 14);
    assert.equal(Number(binding.evmDecimals), 18);
    assert.equal(binding.conversionFactor, 10000n);
    assert.equal(binding.active, true);
    assert.equal(await registry.bindingIdOf(erc20), 1n);
    assert.equal(await registry.isBound(erc20), true);
  });

  it('binds an ERC-721 to a native nft collection', async function () {
    const { registry, owner, erc721 } = await deploy();
    await registry.connect(owner).bind(erc721, 1, 2, 7, 0, 0, nativeAccountHash);
    const binding = await registry.bindingOfToken(erc721);
    assert.equal(Number(binding.tokenKind), 1);
    assert.equal(Number(binding.nativeKind), 2);
    assert.equal(Number(binding.nativeId), 7);
    assert.equal(binding.conversionFactor, 1n);
  });

  it('binds to NATIVE_NONE with nativeId zero', async function () {
    const { registry, owner, erc20 } = await deploy();
    await registry.connect(owner).bind(erc20, 0, 0, 0, 14, 18, nativeAccountHash);
    assert.equal(await registry.isBound(erc20), true);
  });

  it('rejects NATIVE_NONE with a non-zero native id', async function () {
    const { registry, owner, erc20 } = await deploy();
    await expect(
      registry.connect(owner).bind(erc20, 0, 0, 1, 14, 18, nativeAccountHash)
    ).to.be.revertedWithCustomError(registry, 'InvalidNativeId');
  });

  it('rejects decimal difference that overflows the uint128 factor', async function () {
    const { registry, owner, erc20 } = await deploy();
    await expect(
      registry.connect(owner).bind(erc20, 0, 1, 1, 0, 39, nativeAccountHash)
    ).to.be.revertedWithCustomError(registry, 'InvalidDecimals');
  });

  it('rejects native decimals greater than evm decimals', async function () {
    const { registry, owner, erc20 } = await deploy();
    await expect(
      registry.connect(owner).bind(erc20, 0, 1, 1, 20, 18, nativeAccountHash)
    ).to.be.revertedWithCustomError(registry, 'InvalidDecimals');
  });

  it('rejects nonzero decimals for an ERC-721 binding', async function () {
    const { registry, owner, erc721 } = await deploy();
    await expect(
      registry.connect(owner).bind(erc721, 1, 2, 7, 1, 1, nativeAccountHash)
    ).to.be.revertedWithCustomError(registry, 'InvalidDecimals');
  });

  it('rejects binding an ERC-20 as an ERC-721 and vice versa', async function () {
    const { registry, owner, erc20, erc721 } = await deploy();
    await expect(
      registry.connect(owner).bind(erc721, 0, 1, 1, 14, 18, nativeAccountHash)
    ).to.be.revertedWithCustomError(registry, 'InvalidDecimals');
    await expect(
      registry.connect(owner).bind(erc20, 1, 2, 1, 0, 0, nativeAccountHash)
    ).to.be.revertedWithCustomError(registry, 'InvalidTokenKind');
  });

  it('converts amounts exactly between the EVM and native denominations', async function () {
    const { registry, owner, erc20 } = await deploy();
    await registry.connect(owner).bind(erc20, 0, 1, 4401, 14, 18, nativeAccountHash);

    assert.equal(
      await registry.convertToNative(1n, ethers.parseUnits('1', 18)),
      ethers.parseUnits('1', 14)
    );
    assert.equal(
      await registry.convertToNative(1n, ethers.parseUnits('2', 18)),
      ethers.parseUnits('2', 14)
    );
    assert.equal(
      await registry.convertToEvm(1n, ethers.parseUnits('1', 14)),
      ethers.parseUnits('1', 18)
    );
    assert.equal(
      await registry.convertToEvm(1n, ethers.parseUnits('7', 14)),
      ethers.parseUnits('7', 18)
    );
    assert.equal(await registry.convertToEvm(1n, 0n), 0n);
  });

  it('reverts on non-exact native conversion (no silent truncation)', async function () {
    const { registry, owner, erc20 } = await deploy();
    await registry.connect(owner).bind(erc20, 0, 1, 4401, 14, 18, nativeAccountHash);

    await expect(
      registry.convertToNative(1n, 9999n)
    ).to.be.revertedWithCustomError(registry, 'PrecisionLoss');
    await expect(
      registry.convertToNative(1n, 10000n)
    ).to.not.reverted;
    assert.equal(await registry.convertToNative(1n, 10000n), 1n);
    await expect(
      registry.connect(owner).convertToNative(1n, 12345n)
    ).to.be.revertedWithCustomError(registry, 'PrecisionLoss');
  });

  it('reverts conversion on a binding with no native counterpart', async function () {
    const { registry, owner, erc20 } = await deploy();
    await registry.connect(owner).bind(erc20, 0, 0, 0, 14, 18, nativeAccountHash);
    await expect(
      registry.convertToNative(1n, 10000n)
    ).to.be.revertedWithCustomError(registry, 'NoNativeCounterpart');
    await expect(
      registry.convertToEvm(1n, 1n)
    ).to.be.revertedWithCustomError(registry, 'NoNativeCounterpart');
  });

  it('reverts on reading an unknown binding', async function () {
    const { registry } = await deploy();
    await expect(registry.bindingOf(42n)).to.be.revertedWithCustomError(registry, 'UnknownBinding');
    await expect(registry.bindingOfToken(ZERO)).to.be.revertedWithCustomError(
      registry,
      'UnknownBinding'
    );
    assert.equal(await registry.isBound(ZERO), false);
  });

  it('verifies the native account commitment exactly', async function () {
    const { registry, owner, erc20 } = await deploy();
    await registry.connect(owner).bind(erc20, 0, 1, 4401, 14, 18, nativeAccountHash);
    assert.equal(await registry.verifyNativeAccount(1n, nativeAccountHash), true);
    assert.equal(await registry.verifyNativeAccount(1n, '0x' + '00'.repeat(32)), false);
    await expect(
      registry.verifyNativeAccount(42n, nativeAccountHash)
    ).to.be.revertedWithCustomError(registry, 'UnknownBinding');
  });

  it('rejects binding the same token twice', async function () {
    const { registry, owner, erc20 } = await deploy();
    await registry.connect(owner).bind(erc20, 0, 1, 4401, 14, 18, nativeAccountHash);
    await expect(
      registry.connect(owner).bind(erc20, 0, 1, 4402, 14, 18, nativeAccountHash)
    ).to.be.revertedWithCustomError(registry, 'TokenAlreadyBound');
  });

  it('rejects binding two tokens to the same native id', async function () {
    const { registry, owner } = await deploy();
    const factory = await ethers.getContractFactory('PotERC20');
    const tokenA = await factory.deploy('Token A', 'TKA', owner.address);
    await tokenA.waitForDeployment();
    const addressA = await tokenA.getAddress();
    const tokenB = await factory.deploy('Token B', 'TKB', owner.address);
    await tokenB.waitForDeployment();
    const addressB = await tokenB.getAddress();

    await registry.connect(owner).bind(addressA, 0, 1, 4401, 14, 18, nativeAccountHash);
    await expect(
      registry.connect(owner).bind(addressB, 0, 1, 4401, 14, 18, nativeAccountHash)
    ).to.be.revertedWithCustomError(registry, 'NativeIdAlreadyBound');
  });

  it('allows the same native id under different native kinds', async function () {
    const { registry, owner, erc20, erc721 } = await deploy();
    await registry.connect(owner).bind(erc20, 0, 1, 4401, 14, 18, nativeAccountHash);
    await registry.connect(owner).bind(erc721, 1, 2, 4401, 0, 0, nativeAccountHash);
    assert.equal(await registry.bindingIdOf(erc20), 1n);
    assert.equal(await registry.bindingIdOf(erc721), 2n);
  });

  it('rejects invalid binding parameters', async function () {
    const { registry, owner, alice, erc20, erc721 } = await deploy();
    await expect(
      registry.connect(owner).bind(ZERO, 0, 1, 4401, 14, 18, nativeAccountHash)
    ).to.be.revertedWithCustomError(registry, 'ZeroAddress');
    await expect(
      registry.connect(owner).bind(erc20, 2, 1, 4401, 14, 18, nativeAccountHash)
    ).to.be.revertedWithCustomError(registry, 'InvalidTokenKind');
    await expect(
      registry.connect(owner).bind(erc20, 0, 3, 4401, 14, 18, nativeAccountHash)
    ).to.be.revertedWithCustomError(registry, 'InvalidNativeKind');
    await expect(
      registry.connect(owner).bind(erc20, 0, 1, 0, 14, 18, nativeAccountHash)
    ).to.be.revertedWithCustomError(registry, 'InvalidNativeId');
    await expect(
      registry.connect(owner).bind(erc20, 0, 1, 4401, 18, 14, nativeAccountHash)
    ).to.be.revertedWithCustomError(registry, 'InvalidDecimals');
    await expect(
      registry.connect(alice).bind(erc20, 0, 1, 4401, 14, 18, nativeAccountHash)
    ).to.be.revertedWithCustomError(registry, 'NotOwner');
    await expect(
      registry.connect(owner).bind(owner.address, 0, 1, 4401, 14, 18, nativeAccountHash)
    ).to.be.revertedWithCustomError(registry, 'NotAContract');
    await expect(
      registry.connect(owner).bind(erc721, 0, 1, 1, 14, 18, nativeAccountHash)
    ).to.be.revertedWithCustomError(registry, 'InvalidDecimals');
    await expect(
      registry.connect(owner).bind(erc20, 1, 2, 1, 0, 0, nativeAccountHash)
    ).to.be.revertedWithCustomError(registry, 'InvalidTokenKind');
  });

  it('rejects a zero native account commitment', async function () {
    const { registry, owner, erc20 } = await deploy();
    await expect(
      registry.connect(owner).bind(erc20, 0, 1, 4401, 14, 18, '0x' + '00'.repeat(32))
    ).to.be.revertedWithCustomError(registry, 'InvalidCommitment');
  });

  it('unbinds, frees the native id slot and rotates ownership', async function () {
    const { registry, owner, alice, erc20 } = await deploy();
    await registry.connect(owner).bind(erc20, 0, 1, 4401, 14, 18, nativeAccountHash);
    await expect(registry.connect(owner).unbind(1n))
      .to.emit(registry, 'TokenUnbound')
      .withArgs(1n, erc20);
    assert.equal(await registry.isBound(erc20), false);
    await expect(registry.bindingOfToken(erc20)).to.be.revertedWithCustomError(
      registry,
      'UnknownBinding'
    );

    await registry.connect(owner).bind(erc20, 0, 1, 4401, 14, 18, nativeAccountHash);
    assert.equal(await registry.bindingIdOf(erc20), 2n);

    await registry.connect(owner).transferOwnership(alice.address);
    assert.equal(await registry.owner(), alice.address);
    await expect(
      registry.connect(owner).bind(erc20, 0, 1, 4401, 14, 18, nativeAccountHash)
    ).to.be.revertedWithCustomError(registry, 'NotOwner');
  });

  it('rejects unbinding an already unbound binding', async function () {
    const { registry, owner, erc20 } = await deploy();
    await registry.connect(owner).bind(erc20, 0, 1, 4401, 14, 18, nativeAccountHash);
    await registry.connect(owner).unbind(1n);
    await expect(
      registry.connect(owner).unbind(1n)
    ).to.be.revertedWithCustomError(registry, 'UnknownBinding');
    await expect(registry.bindingOf(1n)).to.be.revertedWithCustomError(
      registry,
      'UnknownBinding'
    );
  });

  it('rejects transferOwnership to zero address', async function () {
    const { registry, owner } = await deploy();
    await expect(registry.connect(owner).transferOwnership(ZERO)).to.be.revertedWithCustomError(
      registry,
      'ZeroAddress'
    );
  });
});
