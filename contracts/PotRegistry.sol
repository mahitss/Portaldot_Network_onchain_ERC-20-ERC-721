pragma solidity 0.8.24;

contract PotRegistry {
    uint8 public constant KIND_ERC20 = 0;
    uint8 public constant KIND_ERC721 = 1;

    uint16 public constant NATIVE_NONE = 0;
    uint16 public constant NATIVE_ASSETS = 1;
    uint16 public constant NATIVE_NFTS = 2;

    struct Binding {
        address token;
        uint8 tokenKind;
        uint16 nativeKind;
        uint32 nativeId;
        uint8 nativeDecimals;
        uint8 evmDecimals;
        uint128 conversionFactor;
        bytes32 nativeAccountHash;
        uint64 registeredAt;
        bool active;
    }

    address public owner;
    uint256 public bindingCount;
    mapping(uint256 => Binding) private _bindings;
    mapping(address => uint256) public bindingIdOf;

    event TokenBound(
        uint256 indexed bindingId,
        address indexed token,
        uint8 tokenKind,
        uint16 nativeKind,
        uint32 nativeId,
        uint8 nativeDecimals,
        uint8 evmDecimals,
        uint128 conversionFactor,
        bytes32 nativeAccountHash
    );
    event TokenUnbound(uint256 indexed bindingId, address indexed token);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error ZeroAddress();
    error UnknownBinding();
    error TokenAlreadyBound();
    error InvalidTokenKind();
    error InvalidNativeKind();
    error InvalidNativeId();
    error InvalidDecimals();

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function bind(
        address token,
        uint8 tokenKind,
        uint16 nativeKind,
        uint32 nativeId,
        uint8 nativeDecimals,
        uint8 evmDecimals,
        bytes32 nativeAccountHash
    ) external onlyOwner returns (uint256 bindingId) {
        if (token == address(0)) revert ZeroAddress();
        if (tokenKind > KIND_ERC721) revert InvalidTokenKind();
        if (nativeKind > NATIVE_NFTS) revert InvalidNativeKind();
        if (nativeKind != NATIVE_NONE && nativeId == 0) revert InvalidNativeId();
        if (evmDecimals < nativeDecimals) revert InvalidDecimals();
        if (bindingIdOf[token] != 0) revert TokenAlreadyBound();

        uint128 factor = uint128(10 ** uint256(evmDecimals - nativeDecimals));
        bindingId = bindingCount + 1;
        bindingCount = bindingId;

        _bindings[bindingId] = Binding({
            token: token,
            tokenKind: tokenKind,
            nativeKind: nativeKind,
            nativeId: nativeId,
            nativeDecimals: nativeDecimals,
            evmDecimals: evmDecimals,
            conversionFactor: factor,
            nativeAccountHash: nativeAccountHash,
            registeredAt: uint64(block.timestamp),
            active: true
        });

        bindingIdOf[token] = bindingId;

        emit TokenBound(
            bindingId,
            token,
            tokenKind,
            nativeKind,
            nativeId,
            nativeDecimals,
            evmDecimals,
            factor,
            nativeAccountHash
        );
    }

    function unbind(uint256 bindingId) external onlyOwner {
        Binding storage binding = _bindings[bindingId];
        if (binding.token == address(0)) revert UnknownBinding();
        binding.active = false;
        delete bindingIdOf[binding.token];
        emit TokenUnbound(bindingId, binding.token);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function bindingOf(uint256 bindingId) external view returns (Binding memory) {
        Binding memory binding = _bindings[bindingId];
        if (binding.token == address(0)) revert UnknownBinding();
        return binding;
    }

    function bindingOfToken(address token) external view returns (Binding memory) {
        uint256 bindingId = bindingIdOf[token];
        Binding memory binding = _bindings[bindingId];
        if (binding.token == address(0)) revert UnknownBinding();
        return binding;
    }

    function isBound(address token) external view returns (bool) {
        return bindingIdOf[token] != 0;
    }

    function convertToNative(uint256 bindingId, uint256 evmAmount) external view returns (uint256) {
        Binding memory binding = _bindings[bindingId];
        if (binding.token == address(0)) revert UnknownBinding();
        return evmAmount / binding.conversionFactor;
    }

    function convertToEvm(uint256 bindingId, uint256 nativeAmount) external view returns (uint256) {
        Binding memory binding = _bindings[bindingId];
        if (binding.token == address(0)) revert UnknownBinding();
        return nativeAmount * binding.conversionFactor;
    }

    function verifyNativeAccount(uint256 bindingId, bytes32 accountHash) external view returns (bool) {
        Binding memory binding = _bindings[bindingId];
        if (binding.token == address(0)) revert UnknownBinding();
        return binding.active && binding.nativeAccountHash == accountHash;
    }
}
