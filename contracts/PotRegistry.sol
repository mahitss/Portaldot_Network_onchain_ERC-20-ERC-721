pragma solidity 0.8.24;

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

contract PotRegistry {
    uint8 public constant KIND_ERC20 = 0;
    uint8 public constant KIND_ERC721 = 1;

    uint16 public constant NATIVE_NONE = 0;
    uint16 public constant NATIVE_ASSETS = 1;
    uint16 public constant NATIVE_NFTS = 2;

    bytes4 private constant ERC165_INTERFACE_ID = 0x01ffc9a7;
    bytes4 private constant ERC721_INTERFACE_ID = 0x80ac58cd;
    uint8 private constant MAX_DECIMAL_DIFFERENCE = 38;

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
    mapping(uint16 => mapping(uint32 => uint256)) public bindingIdOfNative;

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
    error InvalidCommitment();
    error NativeIdAlreadyBound();
    error PrecisionLoss();
    error NotAContract();
    error NoNativeCounterpart();

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
        if (nativeKind == NATIVE_NONE && nativeId != 0) revert InvalidNativeId();
        if (nativeKind != NATIVE_NONE && nativeId == 0) revert InvalidNativeId();
        if (nativeDecimals > evmDecimals) revert InvalidDecimals();
        if (evmDecimals - nativeDecimals > MAX_DECIMAL_DIFFERENCE) revert InvalidDecimals();
        if (bindingIdOf[token] != 0) revert TokenAlreadyBound();
        if (nativeKind != NATIVE_NONE && bindingIdOfNative[nativeKind][nativeId] != 0) revert NativeIdAlreadyBound();
        if (nativeAccountHash == bytes32(0)) revert InvalidCommitment();

        if (tokenKind == KIND_ERC20) {
            if (nativeKind != NATIVE_NONE && nativeKind != NATIVE_ASSETS) revert InvalidNativeKind();
            _verifyERC20(token, evmDecimals);
        } else {
            if (nativeKind != NATIVE_NONE && nativeKind != NATIVE_NFTS) revert InvalidNativeKind();
            if (nativeDecimals != 0 || evmDecimals != 0) revert InvalidDecimals();
            _verifyERC721(token);
        }

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
        if (nativeKind != NATIVE_NONE) {
            bindingIdOfNative[nativeKind][nativeId] = bindingId;
        }

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
        address token = binding.token;
        binding.active = false;
        binding.token = address(0);
        delete bindingIdOf[token];
        if (binding.nativeKind != NATIVE_NONE) {
            delete bindingIdOfNative[binding.nativeKind][binding.nativeId];
        }
        emit TokenUnbound(bindingId, token);
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
        if (binding.nativeKind == NATIVE_NONE) revert NoNativeCounterpart();
        if (evmAmount % binding.conversionFactor != 0) revert PrecisionLoss();
        return evmAmount / binding.conversionFactor;
    }

    function convertToEvm(uint256 bindingId, uint256 nativeAmount) external view returns (uint256) {
        Binding memory binding = _bindings[bindingId];
        if (binding.token == address(0)) revert UnknownBinding();
        if (binding.nativeKind == NATIVE_NONE) revert NoNativeCounterpart();
        return nativeAmount * binding.conversionFactor;
    }

    function verifyNativeAccount(uint256 bindingId, bytes32 accountHash) external view returns (bool) {
        Binding memory binding = _bindings[bindingId];
        if (binding.token == address(0)) revert UnknownBinding();
        return binding.active && binding.nativeAccountHash == accountHash;
    }

    function _verifyERC20(address token, uint8 evmDecimals) private view {
        if (token.code.length == 0) revert NotAContract();
        uint8 tokenDecimals;
        try IERC20Decimals(token).decimals() returns (uint8 d) {
            tokenDecimals = d;
        } catch {
            revert InvalidDecimals();
        }
        if (tokenDecimals != evmDecimals) revert InvalidDecimals();
    }

    function _verifyERC721(address token) private view {
        if (token.code.length == 0) revert NotAContract();
        bool supported;
        try IERC165(token).supportsInterface(ERC721_INTERFACE_ID) returns (bool b) {
            supported = b;
        } catch {
            revert InvalidTokenKind();
        }
        if (!supported) revert InvalidTokenKind();
    }
}
