pragma solidity 0.8.24;

contract ERC721ReceiverMock {
    event Received(address operator, address from, uint256 tokenId, bytes data);

    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4)
    {
        emit Received(operator, from, tokenId, data);
        return this.onERC721Received.selector;
    }
}
