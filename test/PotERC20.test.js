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

  async function sumBalances(token, holders) {
    let total = 0n;
    for (const h of holders) {
      total += await token.balanceOf(h);
    }
    return total;
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

  it('initial supply invariant holds before and after mint', async function () {
    const { token, issuer, alice, bob } = await deploy();
    const holders = [alice.address, bob.address];
    assert.equal(await sumBalances(token, holders), 0n);
    assert.equal(await token.totalSupply(), 0n);

    const amount = ethers.parseUnits('100', 18);
    await token.connect(issuer).mint(alice.address, amount);
    assert.equal(await sumBalances(token, holders), amount);
    assert.equal(await token.totalSupply(), amount);
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

  it('transfers and moves balances with events', async function () {
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

  it('zero-value transfer to a valid recipient succeeds with no balance change', async function () {
    const { token, issuer, alice, bob } = await deploy();
    await token.connect(issuer).mint(alice.address, ethers.parseUnits('10', 18));
    const before = await token.balanceOf(alice.address);
    await expect(token.connect(alice).transfer(bob.address, 0n))
      .to.emit(token, 'Transfer')
      .withArgs(alice.address, bob.address, 0n);
    assert.equal(await token.balanceOf(alice.address), before);
    assert.equal(await token.balanceOf(bob.address), 0n);
    assert.equal(await token.totalSupply(), ethers.parseUnits('10', 18));
  });

  it('transfer to the zero address reverts', async function () {
    const { token, issuer, alice } = await deploy();
    await token.connect(issuer).mint(alice.address, ethers.parseUnits('10', 18));
    await expect(token.connect(alice).transfer(ZERO, 1n)).to.be.revertedWithCustomError(
      token,
      'ZeroAddress'
    );
  });

  it('zero-value transferFrom succeeds with allowance and does not decrement it', async function () {
    const { token, issuer, alice, bob, spender } = await deploy();
    await token.connect(issuer).mint(alice.address, ethers.parseUnits('10', 18));
    await token.connect(alice).approve(spender.address, ethers.parseUnits('5', 18));
    const before = await token.allowance(alice.address, spender.address);
    await expect(token.connect(spender).transferFrom(alice.address, bob.address, 0n))
      .to.emit(token, 'Transfer')
      .withArgs(alice.address, bob.address, 0n);
    assert.equal(await token.allowance(alice.address, spender.address), before);
    assert.equal(await token.balanceOf(bob.address), 0n);
  });

  it('zero-value transferFrom succeeds even without allowance', async function () {
    const { token, issuer, alice, bob, spender } = await deploy();
    await token.connect(issuer).mint(alice.address, ethers.parseUnits('10', 18));
    await expect(token.connect(spender).transferFrom(alice.address, bob.address, 0n))
      .to.emit(token, 'Transfer')
      .withArgs(alice.address, bob.address, 0n);
    assert.equal(await token.balanceOf(bob.address), 0n);
  });

  it('zero-value transferFrom to the zero address reverts', async function () {
    const { token, issuer, alice, spender } = await deploy();
    await token.connect(issuer).mint(alice.address, ethers.parseUnits('10', 18));
    await token.connect(alice).approve(spender.address, ethers.parseUnits('5', 18));
    await expect(
      token.connect(spender).transferFrom(alice.address, ZERO, 0n)
    ).to.be.revertedWithCustomError(token, 'ZeroAddress');
  });

  it('spends allowances and blocks overspending', async function () {
    const { token, issuer, alice, bob, spender } = await deploy();
    const minted = ethers.parseUnits('100', 18);
    const allowanceAmount = ethers.parseUnits('40', 18);
    await token.connect(issuer).mint(alice.address, minted);
    await token.connect(alice).approve(spender.address, allowanceAmount);
    assert.equal(await token.allowance(alice.address, spender.address), allowanceAmount);

    await expect(token.connect(spender).transferFrom(alice.address, bob.address, ethers.parseUnits('15', 18)))
      .to.emit(token, 'Approval')
      .withArgs(alice.address, spender.address, ethers.parseUnits('25', 18));
    assert.equal(await token.balanceOf(bob.address), ethers.parseUnits('15', 18));
    assert.equal(await token.allowance(alice.address, spender.address), ethers.parseUnits('25', 18));

    await expect(
      token.connect(spender).transferFrom(alice.address, bob.address, ethers.parseUnits('50', 18))
    ).to.be.revertedWithCustomError(token, 'InsufficientAllowance');
  });

  it('rejects transferFrom without approval and with zero recipient', async function () {
    const { token, issuer, alice, bob, spender } = await deploy();
    await token.connect(issuer).mint(alice.address, ethers.parseUnits('10', 18));
    await expect(
      token.connect(spender).transferFrom(alice.address, bob.address, 1n)
    ).to.be.revertedWithCustomError(token, 'InsufficientAllowance');
    await token.connect(alice).approve(spender.address, ethers.parseUnits('10', 18));
    await expect(
      token.connect(spender).transferFrom(alice.address, ZERO, 1n)
    ).to.be.revertedWithCustomError(token, 'ZeroAddress');
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
    const { token, owner, issuer, alice } = await deploy();
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

  it('rejects burning by an unrelated account, zero amount and above balance', async function () {
    const { token, issuer, alice, bob } = await deploy();
    await token.connect(issuer).mint(alice.address, ethers.parseUnits('10', 18));
    await expect(token.connect(bob).burn(alice.address, 1n)).to.be.revertedWithCustomError(
      token,
      'NotAuthorized'
    );
    await expect(token.connect(alice).burn(alice.address, 0n)).to.be.revertedWithCustomError(
      token,
      'ZeroAmount'
    );
    await expect(
      token.connect(alice).burn(alice.address, ethers.parseUnits('11', 18))
    ).to.be.revertedWithCustomError(token, 'InsufficientBalance');
  });

  it('pauses and unpauses transfers, mints and burns', async function () {
    const { token, owner, issuer, alice, bob } = await deploy();
    await token.connect(issuer).mint(alice.address, ethers.parseUnits('10', 18));

    await expect(token.connect(owner).pause()).to.emit(token, 'PauseUpdated').withArgs(true);
    await assert.equal(await token.isPaused(), true);
    await expect(
      token.connect(alice).transfer(bob.address, 1n)
    ).to.be.revertedWithCustomError(token, 'TokenIsPaused');
    await expect(
      token.connect(issuer).mint(alice.address, 1n)
    ).to.be.revertedWithCustomError(token, 'TokenIsPaused');
    await expect(
      token.connect(alice).burn(alice.address, 1n)
    ).to.be.revertedWithCustomError(token, 'TokenIsPaused');

    await token.connect(owner).unpause();
    assert.equal(await token.isPaused(), false);
    await expect(token.connect(owner).unpause()).to.emit(token, 'PauseUpdated').withArgs(false);
    await token.connect(alice).transfer(bob.address, 1n);
    assert.equal(await token.balanceOf(bob.address), 1n);
  });

  it('pause is owner-restricted', async function () {
    const { token, alice, issuer } = await deploy();
    await expect(token.connect(alice).pause()).to.be.revertedWithCustomError(token, 'NotOwner');
    await expect(token.connect(issuer).unpause()).to.be.revertedWithCustomError(token, 'NotOwner');
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

  it('setIssuer rejects zero address', async function () {
    const { token, owner } = await deploy();
    await expect(token.connect(owner).setIssuer(ZERO)).to.be.revertedWithCustomError(
      token,
      'ZeroAddress'
    );
  });

  it('transferOwnership rejects zero address', async function () {
    const { token, owner } = await deploy();
    await expect(token.connect(owner).transferOwnership(ZERO)).to.be.revertedWithCustomError(
      token,
      'ZeroAddress'
    );
  });
});
