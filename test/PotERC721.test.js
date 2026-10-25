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

  it('implements ERC-165 supportsInterface for ERC-165 and ERC-721', async function () {
    const { collection } = await deploy();
    assert.equal(await collection.supportsInterface('0x01ffc9a7'), true);
    assert.equal(await collection.supportsInterface('0x80ac58cd'), true);
    assert.equal(await collection.supportsInterface('0x00000000'), false);
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

  it('totalSupply decrements on burn (live counter, not nextTokenId-1)', async function () {
    const { collection, issuer, alice } = await deploy();
    await collection.connect(issuer).mint(alice.address, 'ipfs://token/1');
    await collection.connect(issuer).mint(alice.address, 'ipfs://token/2');
    assert.equal(await collection.totalSupply(), 2n);

    await collection.connect(alice).burn(1n);
    assert.equal(await collection.totalSupply(), 1n);
    assert.equal(await collection.exists(1n), false);
    assert.equal(await collection.balanceOf(alice.address), 1n);

    await collection.connect(alice).burn(2n);
    assert.equal(await collection.totalSupply(), 0n);
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
    assert.equal(await collection.getApproved(1n), ZERO);

    await collection.connect(bob).approve(operator.address, 1n);
    await expect(collection.connect(operator).transferFrom(bob.address, alice.address, 1n))
      .to.emit(collection, 'Transfer')
      .withArgs(bob.address, alice.address, 1n);
    assert.equal(await collection.ownerOf(1n), alice.address);

    await collection.connect(alice).setApprovalForAll(operator.address, true);
    assert.equal(await collection.isApprovedForAll(alice.address, operator.address), true);
    await collection.connect(operator).transferFrom(alice.address, bob.address, 1n);
    assert.equal(await collection.ownerOf(1n), bob.address);
    assert.equal(await collection.balanceOf(alice.address), 0n);
    assert.equal(await collection.balanceOf(bob.address), 1n);
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
    await expect(
      collection.connect(bob).transferFrom(alice.address, bob.address, 1n)
    ).to.be.revertedWithCustomError(collection, 'NotAuthorized');
    await collection.connect(alice).approve(operator.address, 1n);
    await expect(
      collection.connect(operator).transferFrom(bob.address, alice.address, 1n)
    ).to.be.revertedWithCustomError(collection, 'WrongFromAddress');
  });

  it('rejects self approval and zero operator as operator', async function () {
    const { collection, alice } = await deploy();
    await expect(
      collection.connect(alice).setApprovalForAll(alice.address, true)
    ).to.be.revertedWithCustomError(collection, 'NotAuthorized');
    await expect(
      collection.connect(alice).setApprovalForAll(ZERO, true)
    ).to.be.revertedWithCustomError(collection, 'ZeroAddress');
  });

  it('approve flow and getApproved', async function () {
    const { collection, issuer, alice, bob, operator } = await deploy();
    await collection.connect(issuer).mint(alice.address, 'ipfs://token/1');
    assert.equal(await collection.getApproved(1n), ZERO);

    await collection.connect(alice).approve(operator.address, 1n);
    assert.equal(await collection.getApproved(1n), operator.address);
    await expect(
      collection.connect(alice).approve(operator.address, 2n)
    ).to.be.revertedWithCustomError(collection, 'TokenDoesNotExist');
    await expect(
      collection.connect(bob).approve(operator.address, 1n)
    ).to.be.revertedWithCustomError(collection, 'NotAuthorized');

    await collection.connect(operator).transferFrom(alice.address, operator.address, 1n);
    assert.equal(await collection.getApproved(1n), ZERO);
    assert.equal(await collection.ownerOf(1n), operator.address);
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
    assert.equal(await collection.totalSupply(), 0n);
  });

  it('burn custodial by issuer and owner', async function () {
    const { collection, owner, issuer, alice } = await deploy();
    await collection.connect(issuer).mint(alice.address, 'ipfs://token/1');

    await collection.connect(issuer).burn(1n);
    assert.equal(await collection.exists(1n), false);
    assert.equal(await collection.totalSupply(), 0n);

    await collection.connect(issuer).mint(alice.address, 'ipfs://token/2');
    await collection.connect(owner).burn(2n);
    assert.equal(await collection.exists(2n), false);
  });

  it('rejects burning a token that does not exist and unauthorized burn', async function () {
    const { collection, issuer, alice, operator } = await deploy();
    await expect(collection.connect(alice).burn(99n)).to.be.revertedWithCustomError(
      collection,
      'TokenDoesNotExist'
    );
    await collection.connect(issuer).mint(alice.address, 'ipfs://token/1');
    await expect(collection.connect(operator).burn(1n)).to.be.revertedWithCustomError(
      collection,
      'NotAuthorized'
    );
  });

  it('clears approval on transfer', async function () {
    const { collection, issuer, alice, bob, operator } = await deploy();
    await collection.connect(issuer).mint(alice.address, 'ipfs://token/1');
    await collection.connect(alice).approve(operator.address, 1n);
    assert.equal(await collection.getApproved(1n), operator.address);

    await collection.connect(alice).transferFrom(alice.address, bob.address, 1n);
    assert.equal(await collection.getApproved(1n), ZERO);
    assert.equal(await collection.ownerOf(1n), bob.address);
  });

  it('updates metadata for the owner, issuer or contract owner', async function () {
    const { collection, owner, issuer, alice, operator } = await deploy();
    await collection.connect(issuer).mint(alice.address, 'ipfs://token/1');
    await collection.connect(alice).setTokenURI(1n, 'ipfs://token/1-v2');
    assert.equal(await collection.tokenURI(1n), 'ipfs://token/1-v2');
    await collection.connect(issuer).setTokenURI(1n, 'ipfs://token/1-v3');
    assert.equal(await collection.tokenURI(1n), 'ipfs://token/1-v3');
    await collection.connect(owner).setTokenURI(1n, 'ipfs://token/1-v4');
    assert.equal(await collection.tokenURI(1n), 'ipfs://token/1-v4');

    await expect(collection.connect(alice).setTokenURI(99n, 'ipfs://x')).to.be.revertedWithCustomError(
      collection,
      'TokenDoesNotExist'
    );
    await expect(
      collection.connect(operator).setTokenURI(1n, 'ipfs://x')
    ).to.be.revertedWithCustomError(collection, 'NotAuthorized');
  });

  it('burn clears the approval and decrements live supply', async function () {
    const { collection, issuer, alice, operator } = await deploy();
    await collection.connect(issuer).mint(alice.address, 'ipfs://token/1');
    await collection.connect(alice).approve(operator.address, 1n);
    assert.equal(await collection.getApproved(1n), operator.address);

    await collection.connect(operator).burn(1n);
    assert.equal(await collection.exists(1n), false);
    assert.equal(await collection.balanceOf(alice.address), 0n);
    assert.equal(await collection.totalSupply(), 0n);
  });

  it('safe transfers to a compliant receiver and rejects a non receiver', async function () {
    const { collection, issuer, alice } = await deploy();
    const receiverFactory = await ethers.getContractFactory('ERC721ReceiverMock');
    const receiver = await receiverFactory.deploy();
    await receiver.waitForDeployment();
    const nonReceiverFactory = await ethers.getContractFactory('NonReceiverMock');
    const nonReceiver = await nonReceiverFactory.deploy();
    await nonReceiver.waitForDeployment();

    await collection.connect(issuer).mint(alice.address, 'ipfs://token/1');
    const receiverAddress = await receiver.getAddress();
    await expect(
      collection.connect(alice).safeTransferFrom(alice.address, receiverAddress, 1n)
    ).to.emit(receiver, 'Received');
    assert.equal(await collection.ownerOf(1n), receiverAddress);

    await collection.connect(issuer).mint(alice.address, 'ipfs://token/2');
    const nonReceiverAddress = await nonReceiver.getAddress();
    await expect(
      collection.connect(alice).safeTransferFrom(alice.address, nonReceiverAddress, 2n)
    ).to.be.revertedWithCustomError(collection, 'NotReceiver');
    assert.equal(await collection.ownerOf(2n), alice.address);
  });

  it('safeTransferFrom with bytes data overload', async function () {
    const { collection, issuer, alice } = await deploy();
    const receiverFactory = await ethers.getContractFactory('ERC721ReceiverMock');
    const receiver = await receiverFactory.deploy();
    await receiver.waitForDeployment();
    const receiverAddress = await receiver.getAddress();

    await collection.connect(issuer).mint(alice.address, 'ipfs://token/1');
    const data = ethers.encodeBytes32String('memo');
    await expect(
      collection['safeTransferFrom(address,address,uint256,bytes)'](
        alice.address,
        receiverAddress,
        1n,
        data
      )
    ).to.emit(receiver, 'Received');
    assert.equal(await collection.ownerOf(1n), receiverAddress);
  });

  it('safeTransferFrom to an EOA is allowed', async function () {
    const { collection, issuer, alice, bob } = await deploy();
    await collection.connect(issuer).mint(alice.address, 'ipfs://token/1');
    await collection.connect(alice).safeTransferFrom(alice.address, bob.address, 1n);
    assert.equal(await collection.ownerOf(1n), bob.address);
  });

  it('rejects transferring to the zero address', async function () {
    const { collection, issuer, alice } = await deploy();
    await collection.connect(issuer).mint(alice.address, 'ipfs://token/1');
    await expect(
      collection.connect(alice).transferFrom(alice.address, ZERO, 1n)
    ).to.be.revertedWithCustomError(collection, 'ZeroAddress');
    await expect(
      collection.connect(alice).safeTransferFrom(alice.address, ZERO, 1n)
    ).to.be.revertedWithCustomError(collection, 'ZeroAddress');
  });

  it('rejects minting duplicate token ids is impossible (sequential counter)', async function () {
    const { collection, issuer, alice } = await deploy();
    await collection.connect(issuer).mint(alice.address, 'ipfs://token/1');
    await collection.connect(issuer).mint(alice.address, 'ipfs://token/2');
    assert.equal(await collection.ownerOf(1n), alice.address);
    assert.equal(await collection.ownerOf(2n), alice.address);
    assert.equal(await collection.totalSupply(), 2n);
  });

  it('rotates issuer and owner', async function () {
    const { collection, owner, issuer, alice, bob } = await deploy();
    await collection.connect(owner).setIssuer(bob.address);
    await expect(
      collection.connect(issuer).mint(alice.address, 'ipfs://x')
    ).to.be.revertedWithCustomError(collection, 'NotIssuer');
    await collection.connect(bob).mint(alice.address, 'ipfs://x');
    await collection.connect(owner).transferOwnership(bob.address);
    assert.equal(await collection.owner(), bob.address);
  });
});
