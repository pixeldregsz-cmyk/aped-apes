// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Dummy token-bound account used by the mock registry in tests.
///         Stands in for the real ERC-6551 account implementation.
contract MockAccount {
    // Trailing constructor args appended to the creation code are ignored.
}

/// @notice Test double for the canonical ERC-6551 Registry. Mirrors the real
///         registry's semantics: account() derives the CREATE2 address from
///         (implementation, chainId, tokenContract, tokenId, salt), and
///         createAccount() deploys there (returning the existing account if
///         already deployed).
contract Mock6551Registry {
    function _initCode(
        address implementation,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            type(MockAccount).creationCode,
            abi.encode(implementation, chainId, tokenContract, tokenId)
        );
    }

    function account(
        address implementation,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId,
        uint256 salt
    ) public view returns (address) {
        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                bytes32(salt),
                keccak256(_initCode(implementation, chainId, tokenContract, tokenId))
            )
        );
        return address(uint160(uint256(hash)));
    }

    function createAccount(
        address implementation,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId,
        uint256 salt
    ) external returns (address acc) {
        acc = account(implementation, chainId, tokenContract, tokenId, salt);
        if (acc.code.length == 0) {
            bytes memory initCode = _initCode(implementation, chainId, tokenContract, tokenId);
            address deployed;
            assembly {
                deployed := create2(0, add(initCode, 0x20), mload(initCode), salt)
            }
            require(deployed == acc, "Mock6551Registry: create2 mismatch");
        }
    }
}

/// @notice Test double for the ERC-8004 Identity Registry. Mirrors the real
///         registry's semantics: the identity is an ERC-721 token and
///         register() SAFE-mints it to the caller (so a contract caller
///         must implement onERC721Received, exactly as on Base), returning
///         sequential agentIds starting at 1.
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract Mock8004Registry is ERC721 {
    uint256 public nextAgentId = 1;

    constructor() ERC721("Mock8004Identity", "M8004") {}

    function register(string calldata) external returns (uint256 agentId) {
        agentId = nextAgentId++;
        _safeMint(msg.sender, agentId);
    }
}

/// @notice Minimal ownerOf view the mock adapter uses to read the
///         bound token's current owner under its authority rule.
interface IBoundToken {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @notice Test double for Adapter8004 (Unruggable's ERC-8004 adapter).
///         Mirrors the real adapter's registration semantics this
///         contract relies on: register(standard, boundAddress, tokenId,
///         agentURI) creates the identity in the ERC-8004 registry with
///         the ADAPTER as its owner (custody), stores the binding, and
///         returns the registry's agentId. The call arguments are
///         recorded so tests can assert the collection contract binds
///         the right token under the right standard.
///         The mock also enforces the real adapter's caller-authority
///         rule, modeled faithfully: the caller is authorized when
///         (a) the bound token has no owner yet and the caller is the
///         token contract itself (the ownerless-registration path,
///         built for binding inside the mint transaction), or (b) the
///         caller is the token's current owner, or (c) the token's
///         owner has delegated the caller — the real adapter checks
///         delegate.xyz for the adapter8004.manage grant; here a test
///         records that grant with setManageDelegated. The owner the
///         mock observes at call time is recorded per token
///         (ownerSeenForToken / sawNoOwnerForToken), so a test can
///         prove registration ran BEFORE the token was assigned.
contract MockAdapter8004 {
    struct Binding {
        uint8 standard;
        address boundAddress;
        uint256 tokenId;
    }

    Mock8004Registry public immutable registry;

    uint256 public registerCalls;
    uint8 public lastStandard;
    address public lastBoundAddress;
    uint256 public lastTokenId;
    string public lastAgentURI;
    /// @notice The bound token's owner as observed at the last
    ///         register() call (address(0) when it had no owner).
    address public lastOwnerAtCall;
    bool public lastHadOwnerAtCall;
    mapping(uint256 agentId => Binding) public bindings;
    /// @notice Per-token record of the authority check: the owner seen
    ///         when that token was registered, and whether it had none.
    mapping(uint256 tokenId => address) public ownerSeenForToken;
    mapping(uint256 tokenId => bool) public sawNoOwnerForToken;
    /// @notice Token IDs in the order register() was called.
    uint256[] public registerOrder;
    /// @notice Stand-in for the delegate.xyz adapter8004.manage grant:
    ///         manageDelegated[boundContract][caller], set by tests.
    mapping(address boundContract => mapping(address caller => bool)) public manageDelegated;

    constructor(address registry_) {
        registry = Mock8004Registry(registry_);
    }

    /// @notice Test helper standing in for the token owner granting
    ///         `caller` the adapter8004.manage delegation (delegate.xyz
    ///         on the real deployment).
    function setManageDelegated(address boundContract, address caller, bool allowed) external {
        manageDelegated[boundContract][caller] = allowed;
    }

    function registerOrderLength() external view returns (uint256) {
        return registerOrder.length;
    }

    function _boundOwner(address boundAddress, uint256 tokenId) internal view returns (address) {
        try IBoundToken(boundAddress).ownerOf(tokenId) returns (address o) {
            return o;
        } catch {
            return address(0); // token does not exist yet: no owner
        }
    }

    function register(
        uint8 standard,
        address boundAddress,
        uint256 tokenId,
        string calldata agentURI
    ) external returns (uint256 agentId) {
        // The real adapter's caller-authority rule (see contract note).
        address currentOwner = _boundOwner(boundAddress, tokenId);
        bool authorized = (currentOwner == address(0) && msg.sender == boundAddress) ||
            msg.sender == currentOwner ||
            manageDelegated[boundAddress][msg.sender];
        require(authorized, "MockAdapter: caller not authorized");
        registerCalls++;
        lastStandard = standard;
        lastBoundAddress = boundAddress;
        lastTokenId = tokenId;
        lastAgentURI = agentURI;
        lastOwnerAtCall = currentOwner;
        lastHadOwnerAtCall = currentOwner != address(0);
        ownerSeenForToken[tokenId] = currentOwner;
        sawNoOwnerForToken[tokenId] = currentOwner == address(0);
        registerOrder.push(tokenId);
        // The real adapter has the registry mint the identity NFT to
        // the adapter itself; the mock registry safe-mints to its
        // caller, which here is this adapter — the same custody.
        agentId = registry.register(agentURI);
        bindings[agentId] = Binding(standard, boundAddress, tokenId);
    }

    function bindingOf(uint256 agentId) external view returns (Binding memory) {
        return bindings[agentId];
    }

    /// @notice The mock registry safe-mints the identity to this
    ///         adapter, so the adapter must accept ERC-721 transfers —
    ///         as the real Adapter does (it implements IERC721Receiver).
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
