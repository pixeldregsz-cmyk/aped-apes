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

/// @notice Test double for Adapter8004 (Unruggable's ERC-8004 adapter).
///         Mirrors the real adapter's registration semantics this
///         contract relies on: register(standard, boundAddress, tokenId,
///         agentURI) creates the identity in the ERC-8004 registry with
///         the ADAPTER as its owner (custody), stores the binding, and
///         returns the registry's agentId. The call arguments are
///         recorded so tests can assert the collection contract binds
///         the right token under the right standard. (The real adapter
///         additionally gates the caller under its binding rules; the
///         mock records instead of gating.)
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
    mapping(uint256 agentId => Binding) public bindings;

    constructor(address registry_) {
        registry = Mock8004Registry(registry_);
    }

    function register(
        uint8 standard,
        address boundAddress,
        uint256 tokenId,
        string calldata agentURI
    ) external returns (uint256 agentId) {
        registerCalls++;
        lastStandard = standard;
        lastBoundAddress = boundAddress;
        lastTokenId = tokenId;
        lastAgentURI = agentURI;
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
