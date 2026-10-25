pragma solidity 0.8.24;

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

contract PotERC721 {
    string public name;
    string public symbol;
    address public owner;
    address public issuer;

    uint256 private _nextTokenId = 1;
    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;
    mapping(uint256 => string) private _tokenURIs;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed tokenOwner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed tokenOwner, address indexed operator, bool approved);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event IssuerUpdated(address indexed previousIssuer, address indexed newIssuer);
    event MetadataUpdated(uint256 indexed tokenId, string uri);

    error NotOwner();
    error NotIssuer();
    error NotAuthorized();
    error ZeroAddress();
    error TokenDoesNotExist();
    error TokenAlreadyExists();
    error WrongFromAddress();
    error NotReceiver();

    constructor(string memory collectionName, string memory collectionSymbol, address collectionIssuer) {
        owner = msg.sender;
        issuer = collectionIssuer == address(0) ? msg.sender : collectionIssuer;
        name = collectionName;
        symbol = collectionSymbol;
        emit OwnershipTransferred(address(0), msg.sender);
        emit IssuerUpdated(address(0), issuer);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert NotIssuer();
        _;
    }

    function mint(address to, string memory uri) external onlyIssuer returns (uint256 tokenId) {
        if (to == address(0)) revert ZeroAddress();
        tokenId = _nextTokenId;
        _nextTokenId += 1;
        _owners[tokenId] = to;
        _balances[to] += 1;
        _tokenURIs[tokenId] = uri;
        emit Transfer(address(0), to, tokenId);
        emit MetadataUpdated(tokenId, uri);
    }

    function burn(uint256 tokenId) external {
        address tokenOwner = _owners[tokenId];
        if (tokenOwner == address(0)) revert TokenDoesNotExist();
        if (!_isAuthorized(msg.sender, tokenId)) revert NotAuthorized();
        delete _tokenApprovals[tokenId];
        delete _tokenURIs[tokenId];
        unchecked {
            _balances[tokenOwner] -= 1;
        }
        _owners[tokenId] = address(0);
        emit Transfer(tokenOwner, address(0), tokenId);
    }

    function setTokenURI(uint256 tokenId, string memory uri) external {
        address tokenOwner = _owners[tokenId];
        if (tokenOwner == address(0)) revert TokenDoesNotExist();
        if (msg.sender != tokenOwner && msg.sender != issuer && msg.sender != owner) revert NotAuthorized();
        _tokenURIs[tokenId] = uri;
        emit MetadataUpdated(tokenId, uri);
    }

    function setIssuer(address newIssuer) external onlyOwner {
        if (newIssuer == address(0)) revert ZeroAddress();
        emit IssuerUpdated(issuer, newIssuer);
        issuer = newIssuer;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function approve(address to, uint256 tokenId) external {
        address tokenOwner = _owners[tokenId];
        if (tokenOwner == address(0)) revert TokenDoesNotExist();
        if (msg.sender != tokenOwner && !_isApprovedOrOwner(msg.sender, tokenId)) revert NotAuthorized();
        _tokenApprovals[tokenId] = to;
        emit Approval(tokenOwner, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        if (operator == address(0)) revert ZeroAddress();
        if (operator == msg.sender) revert NotAuthorized();
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        _transfer(from, to, tokenId);
        if (to.code.length > 0) {
            try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, '') returns (bytes4 retval) {
                if (retval != IERC721Receiver.onERC721Received.selector) revert NotReceiver();
            } catch {
                revert NotReceiver();
            }
        }
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address tokenOwner = _owners[tokenId];
        if (tokenOwner == address(0)) revert TokenDoesNotExist();
        return tokenOwner;
    }

    function balanceOf(address tokenOwner) external view returns (uint256) {
        if (tokenOwner == address(0)) revert ZeroAddress();
        return _balances[tokenOwner];
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        if (_owners[tokenId] == address(0)) revert TokenDoesNotExist();
        return _tokenApprovals[tokenId];
    }

    function isApprovedForAll(address tokenOwner, address operator) public view returns (bool) {
        return _operatorApprovals[tokenOwner][operator];
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (_owners[tokenId] == address(0)) revert TokenDoesNotExist();
        return _tokenURIs[tokenId];
    }

    function totalSupply() external view returns (uint256) {
        return _nextTokenId - 1;
    }

    function exists(uint256 tokenId) external view returns (bool) {
        return _owners[tokenId] != address(0);
    }

    function isApprovedOrOwner(address spender, uint256 tokenId) public view returns (bool) {
        address tokenOwner = _owners[tokenId];
        if (tokenOwner == address(0)) revert TokenDoesNotExist();
        return _isApprovedOrOwner(spender, tokenId);
    }

    function _isApprovedOrOwner(address spender, uint256 tokenId) internal view returns (bool) {
        address tokenOwner = _owners[tokenId];
        return spender == tokenOwner
            || spender == issuer
            || spender == owner
            || spender == _tokenApprovals[tokenId]
            || _operatorApprovals[tokenOwner][spender];
    }

    function _isAuthorized(address spender, uint256 tokenId) internal view returns (bool) {
        return _isApprovedOrOwner(spender, tokenId);
    }

    function _transfer(address from, address to, uint256 tokenId) internal {
        if (to == address(0)) revert ZeroAddress();
        address tokenOwner = _owners[tokenId];
        if (tokenOwner == address(0)) revert TokenDoesNotExist();
        if (tokenOwner != from) revert WrongFromAddress();
        if (!_isApprovedOrOwner(msg.sender, tokenId)) revert NotAuthorized();
        delete _tokenApprovals[tokenId];
        unchecked {
            _balances[from] -= 1;
        }
        _balances[to] += 1;
        _owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }
}
