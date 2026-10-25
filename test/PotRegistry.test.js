const assert = require('node:assert/strict');
const { expect } = require('chai');
const { ethers } = require('hardhat');

const ZERO = '0x0000000000000000000000000000000000000000';

describe('PotRegistry', function () {
  async function deploy() {
    const [owner, alice, token] = await ethers.getSigners();
    const factory = await ethers.getContractFactory('PotRegistry');
    const registry = await factory.deploy();
    await registry.waitForDeployment();
    return { registry, owner, alice, token };
  }

  const nativeAccountHash = '0x' + 'ab'.repeat(32);

  it('binds an ERC-20 to a native asset with the unit conversion factor', async function () {
    const { registry, owner, token } = await deploy();
    await expect(
      registry.connect(owner).bind(token.address, 0, 1, 4401, 14, 18, nativeAccountHash)
    )
      .to.emit(registry, 'TokenBound')
      .withArgs(1n, token.address, 0n, 1n, 4401n, 14n, 18n, 10000n, nativeAccountHash);

    const binding = await registry.bindingOf(1n);
    assert.equal(binding.token, token.address);
    assert.equal(Number(binding.tokenKind), 0);
    assert.equal(Number(binding.nativeKind), 1);
    assert.equal(Number(binding.nativeId), 4401);
    assert.equal(Number(binding.nativeDecimals), 14);
    assert.equal(Number(binding.evmDecimals), 18);
    assert.equal(binding.conversionFactor, 10000n);
    assert.equal(binding.active, true);
    assert.equal(await registry.bindingIdOf(token.address), 1n);
    assert.equal(await registry.isBound(token.address), true);
  });

  it('converts amounts between the EVM and native denominations', async function () {
    const { registry, owner, token } = await deploy();
    await registry.connect(owner).bind(token.address, 0, 1, 4401, 14, 18, nativeAccountHash);

    assert.equal(
      await registry.convertToNative(1n, ethers.parseUnits('1', 18)),
      ethers.parseUnits('1', 14)
    );
    assert.equal(
      await registry.convertToEvm(1n, ethers.parseUnits('1', 14)),
      ethers.parseUnits('1', 18)
    );
    assert.equal(await registry.convertToNative(1n, 9999n), 0n);
    assert.equal(await registry.convertToEvm(1n, 1n), 10000n);
  });

  it('verifies the native account commitment', async function () {
    const { registry, owner, token } = await deploy();
    await registry.connect(owner).bind(token.address, 0, 1, 4401, 14, 18, nativeAccountHash);
    assert.equal(await registry.verifyNativeAccount(1n, nativeAccountHash), true);
    assert.equal(await registry.verifyNativeAccount(1n, '0x' + '00'.repeat(32)), false);
  });

  it('binds an ERC-721 to a native nft collection', async function () {
    const { registry, owner, token } = await deploy();
    await registry.connect(owner).bind(token.address, 1, 2, 7, 0, 0, nativeAccountHash);
    const binding = await registry.bindingOfToken(token.address);
    assert.equal(Number(binding.tokenKind), 1);
    assert.equal(Number(binding.nativeKind), 2);
    assert.equal(Number(binding.nativeId), 7);
    assert.equal(binding.conversionFactor, 1n);
  });

  it('rejects invalid binding parameters', async function () {
    const { registry, owner, alice, token } = await deploy();
    await expect(
      registry.connect(owner).bind(ZERO, 0, 1, 4401, 14, 18, nativeAccountHash)
    ).to.be.revertedWithCustomError(registry, 'ZeroAddress');
    await expect(
      registry.connect(owner).bind(token.address, 2, 1, 4401, 14, 18, nativeAccountHash)
    ).to.be.revertedWithCustomError(registry, 'InvalidTokenKind');
    await expect(
      registry.connect(owner).bind(token.address, 0, 3, 4401, 14, 18, nativeAccountHash)
    ).to.be.revertedWithCustomError(registry, 'InvalidNativeKind');
    await expect(
      registry.connect(owner).bind(token.address, 0, 1, 0, 14, 18, nativeAccountHash)
    ).to.be.revertedWithCustomError(registry, 'InvalidNativeId');
    await expect(
      registry.connect(owner).bind(token.address, 0, 1, 4401, 18, 14, nativeAccountHash)
    ).to.be.revertedWithCustomError(registry, 'InvalidDecimals');
    await expect(
      registry.connect(alice).bind(token.address, 0, 1, 4401, 14, 18, nativeAccountHash)
    ).to.be.revertedWithCustomError(registry, 'NotOwner');
  });

  it('rejects binding the same token twice', async function () {
    const { registry, owner, token } = await deploy();
    await registry.connect(owner).bind(token.address, 0, 1, 4401, 14, 18, nativeAccountHash);
    await expect(
      registry.connect(owner).bind(token.address, 0, 1, 4402, 14, 18, nativeAccountHash)
    ).to.be.revertedWithCustomError(registry, 'TokenAlreadyBound');
  });

  it('unbinds and rotates ownership', async function () {
    const { registry, owner, alice, token } = await deploy();
    await registry.connect(owner).bind(token.address, 0, 1, 4401, 14, 18, nativeAccountHash);
    await expect(registry.connect(owner).unbind(1n))
      .to.emit(registry, 'TokenUnbound')
      .withArgs(1n, token.address);
    assert.equal(await registry.isBound(token.address), false);
    await expect(registry.bindingOfToken(token.address)).to.be.revertedWithCustomError(
      registry,
      'UnknownBinding'
    );

    await registry.connect(owner).transferOwnership(alice.address);
    assert.equal(await registry.owner(), alice.address);
    await expect(
      registry.connect(owner).bind(token.address, 0, 1, 4401, 14, 18, nativeAccountHash)
    ).to.be.revertedWithCustomError(registry, 'NotOwner');
  });

  it('rejects reading an unknown binding', async function () {
    const { registry } = await deploy();
    await expect(registry.bindingOf(42n)).to.be.revertedWithCustomError(registry, 'UnknownBinding');
  });
});
