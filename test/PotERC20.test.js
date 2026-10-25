const assert = require('node:assert/strict');
const { expect } = require('chai');
const { ethers } = require('hardhat');

const ZERO = '0x0000000000000000000000000000000000000000';

describe('PotERC20', function () {
  async function deploy() {
    const [owner, issuer, alice, bob, spender] = await ethers.getSigners();
    const factory = await ethers.getContractFactory('PotERC20');
    const token = await factory.deploy('Portaldot Test Token', 'PTT', issuer.address);
    await token.waitForDeployment();
    return { token, owner, issuer, alice, bob, spender };
  }

  it('exposes standard metadata and roles', async function () {
    const { token, owner, issuer } = await deploy();
    assert.equal(await token.name(), 'Portaldot Test Token');
    assert.equal(await token.symbol(), 'PTT');
    assert.equal(Number(await token.decimals()), 18);
    assert.equal(await token.owner(), owner.address);
    assert.equal(await token.issuer(), issuer.address);
    assert.equal(await token.totalSupply(), 0n);
    assert.equal(await token.isPaused(), false);
  });

  it('lets the issuer mint and emits a mint transfer', async function () {
    const { token, issuer, alice } = await deploy();
    const amount = ethers.parseUnits('100', 18);
    await expect(token.connect(issuer).mint(alice.address, amount))
      .to.emit(token, 'Transfer')
      .withArgs(ZERO, alice.address, amount);
    assert.equal(await token.balanceOf(alice.address), amount);
    assert.equal(await token.totalSupply(), amount);
  });

  it('rejects minting from a non issuer', async function () {
    const { token, alice } = await deploy();
    await expect(token.connect(alice).mint(alice.address, 1n)).to.be.revertedWithCustomError(
      token,
      'NotIssuer'
    );
  });

  it('rejects zero amount and zero address mints', async function () {
    const { token, issuer, alice } = await deploy();
    await expect(token.connect(issuer).mint(alice.address, 0n)).to.be.revertedWithCustomError(
      token,
      'ZeroAmount'
    );
    await expect(token.connect(issuer).mint(ZERO, 1n)).to.be.revertedWithCustomError(
      token,
      'ZeroAddress'
    );
  });

  it('transfers and moves balances', async function () {
    const { token, issuer, alice, bob } = await deploy();
    const amount = ethers.parseUnits('10', 18);
    await token.connect(issuer).mint(alice.address, amount);
    await expect(token.connect(alice).transfer(bob.address, ethers.parseUnits('3', 18)))
      .to.emit(token, 'Transfer')
      .withArgs(alice.address, bob.address, ethers.parseUnits('3', 18));
    assert.equal(await token.balanceOf(alice.address), ethers.parseUnits('7', 18));
    assert.equal(await token.balanceOf(bob.address), ethers.parseUnits('3', 18));
    assert.equal(await token.totalSupply(), amount);
  });

  it('rejects transfers above balance', async function () {
    const { token, alice, bob } = await deploy();
    await expect(token.connect(alice).transfer(bob.address, 1n)).to.be.revertedWithCustomError(
      token,
      'InsufficientBalance'
    );
  });

  it('spends allowances and blocks overspending', async function () {
    const { token, issuer, alice, bob, spender } = await deploy();
    const minted = ethers.parseUnits('100', 18);
    const allowanceAmount = ethers.parseUnits('40', 18);
    await token.connect(issuer).mint(alice.address, minted);
    await token.connect(alice).approve(spender.address, allowanceAmount);
    assert.equal(await token.allowance(alice.address, spender.address), allowanceAmount);

    await token.connect(spender).transferFrom(alice.address, bob.address, ethers.parseUnits('15', 18));
    assert.equal(await token.balanceOf(bob.address), ethers.parseUnits('15', 18));
    assert.equal(await token.allowance(alice.address, spender.address), ethers.parseUnits('25', 18));

    await expect(
      token.connect(spender).transferFrom(alice.address, bob.address, ethers.parseUnits('50', 18))
    ).to.be.revertedWithCustomError(token, 'InsufficientAllowance');
  });

  it('keeps an infinite allowance intact', async function () {
    const { token, issuer, alice, bob, spender } = await deploy();
    const max = ethers.MaxUint256;
    await token.connect(issuer).mint(alice.address, ethers.parseUnits('10', 18));
    await token.connect(alice).approve(spender.address, max);
    await token.connect(spender).transferFrom(alice.address, bob.address, ethers.parseUnits('4', 18));
    assert.equal(await token.allowance(alice.address, spender.address), max);
  });

  it('allows the holder, issuer and owner to burn', async function () {
    const { token, owner, issuer, alice, bob } = await deploy();
    const minted = ethers.parseUnits('20', 18);
    await token.connect(issuer).mint(alice.address, minted);

    await token.connect(alice).burn(alice.address, ethers.parseUnits('5', 18));
    assert.equal(await token.totalSupply(), ethers.parseUnits('15', 18));

    await token.connect(issuer).burn(alice.address, ethers.parseUnits('5', 18));
    assert.equal(await token.totalSupply(), ethers.parseUnits('10', 18));

    await token.connect(owner).burn(alice.address, ethers.parseUnits('10', 18));
    assert.equal(await token.totalSupply(), 0n);
    assert.equal(await token.balanceOf(alice.address), 0n);
  });

  it('rejects burning by an unrelated account and above balance', async function () {
    const { token, issuer, alice, bob } = await deploy();
    await token.connect(issuer).mint(alice.address, ethers.parseUnits('10', 18));
    await expect(token.connect(bob).burn(alice.address, 1n)).to.be.revertedWithCustomError(
      token,
      'NotAuthorized'
    );
    await expect(
      token.connect(alice).burn(alice.address, ethers.parseUnits('11', 18))
    ).to.be.revertedWithCustomError(token, 'InsufficientBalance');
  });

  it('pauses and unpauses transfers and mints', async function () {
    const { token, owner, issuer, alice, bob } = await deploy();
    await token.connect(issuer).mint(alice.address, ethers.parseUnits('10', 18));

    await expect(token.connect(owner).pause()).to.emit(token, 'PauseUpdated').withArgs(true);
    await expect(
      token.connect(alice).transfer(bob.address, 1n)
    ).to.be.revertedWithCustomError(token, 'TokenIsPaused');
    await expect(
      token.connect(issuer).mint(alice.address, 1n)
    ).to.be.revertedWithCustomError(token, 'TokenIsPaused');

    await token.connect(owner).unpause();
    await token.connect(alice).transfer(bob.address, 1n);
    assert.equal(await token.balanceOf(bob.address), 1n);
  });

  it('rotates issuer and owner', async function () {
    const { token, owner, issuer, alice, bob } = await deploy();
    await token.connect(owner).setIssuer(bob.address);
    assert.equal(await token.issuer(), bob.address);
    await expect(token.connect(issuer).mint(alice.address, 1n)).to.be.revertedWithCustomError(
      token,
      'NotIssuer'
    );
    await token.connect(bob).mint(alice.address, 1n);

    await token.connect(owner).transferOwnership(bob.address);
    assert.equal(await token.owner(), bob.address);
    await expect(token.connect(owner).pause()).to.be.revertedWithCustomError(token, 'NotOwner');
  });
});
