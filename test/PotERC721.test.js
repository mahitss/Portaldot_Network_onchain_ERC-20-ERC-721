const assert = require('node:assert/strict');
const { expect } = require('chai');
const { ethers } = require('hardhat');

const ZERO = '0x0000000000000000000000000000000000000000';

describe('PotERC721', function () {
  async function deploy() {
    const [owner, issuer, alice, bob, operator] = await ethers.getSigners();
    const factory = await ethers.getContractFactory('PotERC721');
    const collection = await factory.deploy('Portaldot Test Collection', 'PTC', issuer.address);
    await collection.waitForDeployment();
    return { collection, owner, issuer, alice, bob, operator };
  }

  it('exposes collection metadata and roles', async function () {
    const { collection, owner, issuer } = await deploy();
    assert.equal(await collection.name(), 'Portaldot Test Collection');
    assert.equal(await collection.symbol(), 'PTC');
    assert.equal(await collection.owner(), owner.address);
    assert.equal(await collection.issuer(), issuer.address);
    assert.equal(await collection.totalSupply(), 0n);
  });

  it('mints sequential ids with metadata and events', async function () {
    const { collection, issuer, alice } = await deploy();
    await expect(collection.connect(issuer).mint(alice.address, 'ipfs://token/1'))
      .to.emit(collection, 'Transfer')
      .withArgs(ZERO, alice.address, 1n);
    await expect(collection.connect(issuer).mint(alice.address, 'ipfs://token/2'))
      .to.emit(collection, 'MetadataUpdated')
      .withArgs(2n, 'ipfs://token/2');

    assert.equal(await collection.ownerOf(1n), alice.address);
    assert.equal(await collection.balanceOf(alice.address), 2n);
    assert.equal(await collection.tokenURI(1n), 'ipfs://token/1');
    assert.equal(await collection.exists(1n), true);
    assert.equal(await collection.totalSupply(), 2n);
  });

  it('rejects minting from a non issuer and to the zero address', async function () {
    const { collection, issuer, alice } = await deploy();
    await expect(
      collection.connect(alice).mint(alice.address, 'ipfs://x')
    ).to.be.revertedWithCustomError(collection, 'NotIssuer');
    await expect(
      collection.connect(issuer).mint(ZERO, 'ipfs://x')
    ).to.be.revertedWithCustomError(collection, 'ZeroAddress');
  });

  it('transfers by owner, approved address and operator', async function () {
    const { collection, issuer, alice, bob, operator } = await deploy();
    await collection.connect(issuer).mint(alice.address, 'ipfs://token/1');

    await expect(collection.connect(alice).transferFrom(alice.address, bob.address, 1n))
      .to.emit(collection, 'Transfer')
      .withArgs(alice.address, bob.address, 1n);
    assert.equal(await collection.ownerOf(1n), bob.address);
    assert.equal(await collection.balanceOf(alice.address), 0n);
    assert.equal(await collection.balanceOf(bob.address), 1n);

    await collection.connect(bob).approve(operator.address, 1n);
    await collection.connect(operator).transferFrom(bob.address, alice.address, 1n);
    assert.equal(await collection.ownerOf(1n), alice.address);

    await collection.connect(alice).setApprovalForAll(operator.address, true);
    assert.equal(await collection.isApprovedForAll(alice.address, operator.address), true);
    await collection.connect(operator).transferFrom(alice.address, bob.address, 1n);
    assert.equal(await collection.ownerOf(1n), bob.address);
  });

  it('rejects unauthorized transfers and a wrong from address', async function () {
    const { collection, issuer, alice, bob, operator } = await deploy();
    await collection.connect(issuer).mint(alice.address, 'ipfs://token/1');
    await expect(
      collection.connect(operator).transferFrom(alice.address, bob.address, 1n)
    ).to.be.revertedWithCustomError(collection, 'NotAuthorized');
    await expect(
      collection.connect(alice).transferFrom(bob.address, alice.address, 1n)
    ).to.be.revertedWithCustomError(collection, 'WrongFromAddress');
  });

  it('rejects self approval as operator', async function () {
    const { collection, alice } = await deploy();
    await expect(
      collection.connect(alice).setApprovalForAll(alice.address, true)
    ).to.be.revertedWithCustomError(collection, 'NotAuthorized');
  });

  it('burns by owner, approved address and operator', async function () {
    const { collection, issuer, alice, bob, operator } = await deploy();
    await collection.connect(issuer).mint(alice.address, 'ipfs://token/1');

    await collection.connect(alice).approve(operator.address, 1n);
    await expect(collection.connect(operator).burn(1n))
      .to.emit(collection, 'Transfer')
      .withArgs(alice.address, ZERO, 1n);
    assert.equal(await collection.exists(1n), false);
    assert.equal(await collection.balanceOf(alice.address), 0n);
  });

  it('rejects burning a token that does not exist', async function () {
    const { collection, alice } = await deploy();
    await expect(collection.connect(alice).burn(99n)).to.be.revertedWithCustomError(
      collection,
      'TokenDoesNotExist'
    );
  });

  it('updates metadata for the owner, issuer or registry owner', async function () {
    const { collection, owner, issuer, alice } = await deploy();
    await collection.connect(issuer).mint(alice.address, 'ipfs://token/1');
    await collection.connect(alice).setTokenURI(1n, 'ipfs://token/1-v2');
    assert.equal(await collection.tokenURI(1n), 'ipfs://token/1-v2');
    await collection.connect(issuer).setTokenURI(1n, 'ipfs://token/1-v3');
    assert.equal(await collection.tokenURI(1n), 'ipfs://token/1-v3');
    await collection.connect(owner).setTokenURI(1n, 'ipfs://token/1-v4');
    assert.equal(await collection.tokenURI(1n), 'ipfs://token/1-v4');
  });

  it('safe transfers to a compliant receiver and rejects a non receiver', async function () {
    const { collection, issuer, alice, bob } = await deploy();
    const receiverFactory = await ethers.getContractFactory('ERC721ReceiverMock');
    const receiver = await receiverFactory.deploy();
    await receiver.waitForDeployment();
    const nonReceiverFactory = await ethers.getContractFactory('NonReceiverMock');
    const nonReceiver = await nonReceiverFactory.deploy();
    await nonReceiver.waitForDeployment();

    await collection.connect(issuer).mint(alice.address, 'ipfs://token/1');
    const receiverAddress = await receiver.getAddress();
    const nonReceiverAddress = await nonReceiver.getAddress();
    await expect(
      collection.connect(alice).safeTransferFrom(alice.address, receiverAddress, 1n)
    ).to.emit(receiver, 'Received');
    assert.equal(await collection.ownerOf(1n), receiverAddress);

    await collection.connect(issuer).mint(alice.address, 'ipfs://token/2');
    await expect(
      collection.connect(alice).safeTransferFrom(alice.address, nonReceiverAddress, 2n)
    ).to.be.revertedWithCustomError(collection, 'NotReceiver');
    assert.equal(await collection.ownerOf(2n), alice.address);
  });

  it('rotates issuer and owner', async function () {
    const { collection, owner, issuer, alice, bob } = await deploy();
    await collection.connect(owner).setIssuer(bob.address);
    await expect(
      collection.connect(issuer).mint(alice.address, 'ipfs://x')
    ).to.be.revertedWithCustomError(collection, 'NotIssuer');
    await collection.connect(owner).transferOwnership(bob.address);
    assert.equal(await collection.owner(), bob.address);
  });
});
