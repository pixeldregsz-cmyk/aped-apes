// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice ERC-6551 Registry interface (canonical registry, EIP-6551).
///         createAccount / account take the 5-argument form:
///         (implementation, chainId, tokenContract, tokenId, salt).
interface IERC6551Registry {
    function createAccount(
        address implementation,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId,
        uint256 salt
    ) external returns (address account);

    function account(
        address implementation,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId,
        uint256 salt
    ) external view returns (address account);
}

/// @notice The SeaDrop token surface this contract implements: the subset
///         of ProjectOpenSea/seadrop's IERC721SeaDrop that the SeaDrop
///         contract actually calls on a creator-owned token contract.
///         Full ERC721SeaDrop inheritance was NOT used: upstream
///         ERC721SeaDrop is built on ERC721A + SeaDrop's own
///         ERC721ContractMetadata base, which would mean replacing this
///         contract's OpenZeppelin v5 ERC721/ERC2981 base and all of its
///         existing mint logic. Instead the interface is implemented
///         directly here and routed into the same internal mint path as
///         the direct mints. See the README "SeaDrop" section.
interface ISeaDropToken {
    function mintSeaDrop(
        address minter,
        address feeRecipient,
        address[] calldata mintRecipients,
        uint256[] calldata mintQuantities
    ) external payable;

    function updateAllowedSeaDrop(
        address[] calldata allowedSeaDrop,
        bool allowed
    ) external;

    function getAllowedSeaDrop() external view returns (address[] memory);
}

/// @notice Adapter8004 interface (Unruggable's ERC-8004 adapter) — the
///         registration front-end this contract registers identities
///         through. register() binds a token to a fresh ERC-8004
///         identity: the Identity Registry mints the identity NFT to the
///         ADAPTER itself, which custodies it, and control of the record
///         is re-derived from the bound token's current owner on every
///         call — the identity can never be separated from the token.
///         `standard` is the Adapter's Standard enum, which ABI-encodes
///         as uint8 (0 = ERC721, the control rule "whoever ownerOf
///         returns"), so it is declared uint8 here. Declared per
///         Unruggable's published AdapterImplementation (v0.0.17), the
///         no-metadata overload; the call returns the registry agentId.
///         The adapter address is a deployment parameter — see README.
interface IAdapter8004 {
    function register(
        uint8 standard,
        address boundAddress,
        uint256 tokenId,
        string calldata agentURI
    ) external returns (uint256 agentId);
}

/// @notice ERC-8048 onchain metadata interface (EIP-8048, draft). Every
///         token gets a key/value store on the contract itself, read via
///         metadata(tokenId, key); the optional setter is the contract's
///         own choice (this contract's setMetadata, below). ERC-8048's
///         interface ID is 0xdf670be1 — exactly the selector of
///         metadata(uint256,string), the interface's only function.
///         The ERC-721T Agent Metadata Profile is a reserved key set on
///         top of this interface — context, endpoint[<type>],
///         address[<chain-id>], account[<chain-id>][<index>] — and
///         defines no interface, ID, or events of its own. Declared
///         locally, following the EIP text exactly (same pattern as the
///         local ISeaDropToken above): the installed OpenZeppelin
///         Contracts v5.6.1 ships no ERC-8048 implementation to inherit.
interface IERC8048Metadata {
    /// @notice Get the metadata value stored under `key` for `tokenId`
    ///         (empty bytes when nothing is stored under that key).
    function metadata(uint256 tokenId, string calldata key) external view returns (bytes memory);

    /// @notice Emitted on every metadata write, automatic or manual.
    event MetadataSet(uint256 indexed tokenId, string indexed indexedKey, string key, bytes value);
}

/// @title ApEdApes
/// @notice The ApEd collection: 444 agent apes on Base. Each token is an
///         ERC-721 with its own ERC-6551 token-bound account (created at
///         mint) and an ERC-8004 agent identity registered through
///         Adapter8004 INSIDE the mint itself — register first, then
///         assign to the buyer (Prem's confirmed order, 2026-11-17);
///         the Adapter custodies the identity, bound to the token — and
///         carries an ERC-8048 onchain metadata store holding its
///         ERC-721T agent profile (see the ERC-8048 section below).
///         Design source: BUILD-BOOK.md §1, §2, §7.
///         The public sale's front door is OpenSea via SeaDrop (see the
///         SeaDrop section below); the direct mint() keeps this
///         contract's own phase/whitelist system for a possible mint
///         page. Gen-1 breeding (BUILD-BOOK §12) is intentionally NOT
///         in this version; babies are a later contract addition.
contract ApEdApes is ERC721, ERC2981, Ownable, ReentrancyGuard, IERC8048Metadata {
    // ------------------------------------------------------------------
    // Constants — the confirmed ERC-6551 configuration (same as the live
    // SwampAgentsV2 build).
    // ------------------------------------------------------------------
    uint256 public constant MAX_SUPPLY = 444;
    uint256 public constant MAX_RESERVE = 15; // owner reserve cap — pixel's own set-aside
    address public constant ERC6551_REGISTRY = 0x000000006551c19487814612e58FE06813775758;
    address public constant ERC6551_IMPLEMENTATION = 0x9d8Ee22f8E09965cb97faF6AeAB11b8B4098D5Ec;
    uint256 public constant TBA_SALT = 0;

    /// @notice The ERC-721T address key for Base: "address[<chain-id>]"
    ///         where <chain-id> is the ERC-7930 Chain Identifier for Base
    ///         (chain ID 8453) — 0x0001000002210500, the exact form
    ///         EIP-8048's own Base example gives. The stored value is the
    ///         Address component of the token's ERC-6551 account on Base:
    ///         the raw 20 address bytes, nothing else.
    string public constant BASE_ADDRESS_KEY = "address[0x0001000002210500]";

    /// @notice The Adapter8004 binding standard for these tokens: 0 in
    ///         the Adapter's Standard enum is ERC721 — control of the
    ///         bound identity follows whoever ownerOf(tokenId) returns.
    uint8 public constant ADAPTER_STANDARD_ERC721 = 0;

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------
    uint256 private _nextTokenId = 1; // token IDs run 1..444
    uint256 public totalMinted;
    uint256 public reserveMinted; // reserve mints used so far (cap MAX_RESERVE)

    /// @notice IDs taken by the owner reserve. reserveMint mints a reserved
    ///         ID to pixel's wallet; the public mint never hands one out.
    mapping(uint256 tokenId => bool) public isReserved;
    uint256 public mintPrice; // in wei; owner-settable. $7 at launch — pixel sets the ETH figure at deploy.

    /// @notice Mint phases, owner-controlled via setMintPhase. The mint
    ///         starts Closed; the Whitelist phase admits only allowlisted
    ///         wallets (per-wallet cap); the Public phase admits anyone.
    enum MintPhase {
        Closed,
        Whitelist,
        Public
    }
    MintPhase public mintPhase; // starts Closed

    /// @notice Whitelist-phase allowlist. Only the owner manages it, in
    ///         batches (addToWhitelist / removeFromWhitelist).
    mapping(address wallet => bool) private _whitelist;

    /// @notice Mints each wallet has used in the Whitelist phase, tracked
    ///         against wlPerWallet. Removing a wallet from the list does
    ///         not reset its count.
    mapping(address wallet => uint256) public wlMinted;

    /// @notice Per-wallet mint cap during the Whitelist phase.
    uint256 public wlPerWallet = 1;

    /// @notice SeaDrop contracts the owner has allowed to mint through
    ///         mintSeaDrop (the OpenSea drop door). Managed with
    ///         updateAllowedSeaDrop; NO SeaDrop address is hardcoded —
    ///         the real SeaDrop address for Base is verified and
    ///         registered at deploy time (see README).
    mapping(address seaDrop => bool) private _allowedSeaDrop;
    address[] private _enumeratedAllowedSeaDrop;
    string private _baseTokenURI;

    /// @notice ERC-8004 Identity Registry address. DEPLOYMENT PARAMETER:
    ///         set in the constructor (may be address(0) at deploy and set
    ///         later via setAgentRegistry). The Adapter is configured
    ///         against this registry — the agentIds it returns are
    ///         registry IDs — and registration names this registry in
    ///         the token's ERC-721T agent-registration key. See README.
    address public agentRegistry;

    /// @notice Adapter8004 address — the ERC-8004 registration front-end
    ///         the mint-time registration (and the registerAgent
    ///         fallback) calls. DEPLOYMENT PARAMETER: set in the
    ///         constructor (may be address(0) at deploy and set later via
    ///         setAgentAdapter). For identities to be filed at mint it
    ///         must be set before the mint opens. See README.
    address public agentAdapter;

    /// @notice ERC-8004 agentId recorded per tokenId (0 = not registered).
    mapping(uint256 tokenId => uint256 agentId) public agentIdOf;

    /// @notice ERC-8048 onchain metadata store: tokenId => key => value.
    ///         Populated automatically at mint (the ERC-721T Base address
    ///         key, and the agent-registration key when registration
    ///         runs), and by hand afterwards via setMetadata. Read with
    ///         metadata().
    mapping(uint256 tokenId => mapping(string key => bytes value)) private _tokenMetadata;

    /// @notice Address that receives mint proceeds on withdraw(). Set to
    ///         pixel's wallet at deploy (the same address as the ERC-2981
    ///         royalty receiver).
    address public payoutAddress;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------
    event MintOpened(bool open);
    event MintPhaseSet(MintPhase phase);
    event WhitelistAdded(address indexed wallet);
    event WhitelistRemoved(address indexed wallet);
    event WlPerWalletSet(uint256 cap);
    event MintPriceSet(uint256 priceWei);
    event BaseURISet(string baseURI);
    event AgentRegistrySet(address registry);
    event AgentAdapterSet(address adapter);
    /// @notice ERC-4906 metadata-update signal: emitted on every
    ///         ERC-8048 value write (see _setMetadata) so marketplaces
    ///         — OpenSea, per its metadata docs — refresh the token's
    ///         displayed metadata instead of serving a cached copy.
    event MetadataUpdate(uint256 tokenId);
    event AgentRegistered(uint256 indexed tokenId, uint256 agentId);
    event ReserveMinted(uint256 indexed tokenId, address indexed to);
    event ProceedsWithdrawn(address indexed to, uint256 amount);
    event AllowedSeaDropUpdated(address indexed seaDrop, bool allowed);
    event SeaDropMinted(
        address indexed seaDrop,
        address indexed minter,
        address feeRecipient,
        uint256 totalQuantity
    );

    // ------------------------------------------------------------------
    // Constructor — every value pixel must decide at deploy is a parameter
    // (see README "Deploy parameters"):
    //   _mintPriceWei   mint price in wei (the $7 figure, converted by pixel)
    //   _royaltyBps     ERC-2981 royalty rate in basis points (PIXEL'S OPEN NUMBER)
    //   baseURI_        metadata service base URI (IPFS pointers)
    //   _agentRegistry  ERC-8004 Identity Registry address (may be 0)
    //   _agentAdapter   Adapter8004 address (may be 0)
    // Royalty receiver and payout address are fixed to pixel's wallet.
    // ------------------------------------------------------------------
    constructor(
        uint256 _mintPriceWei,
        uint96 _royaltyBps,
        string memory baseURI_,
        address _agentRegistry,
        address _agentAdapter
    ) ERC721("ApEd", "APED") Ownable(msg.sender) {
        address pixelWallet = 0x4F9883C7331ba59A56360fFa3c332e0Bc09029Fc;
        payoutAddress = pixelWallet;
        mintPrice = _mintPriceWei;
        _baseTokenURI = baseURI_;
        agentRegistry = _agentRegistry;
        agentAdapter = _agentAdapter;
        _setDefaultRoyalty(pixelWallet, _royaltyBps);
        // mintPhase stays Closed: the mint starts CLOSED.
    }

    // ------------------------------------------------------------------
    // Minting
    // ------------------------------------------------------------------

    /// @notice Backwards-compatible view of the original open/closed
    ///         toggle: true whenever the mint is live in any phase
    ///         (Whitelist or Public), false while Closed.
    function mintOpen() external view returns (bool) {
        return mintPhase != MintPhase.Closed;
    }

    /// @notice Mint. Charges exactly mintPrice * quantity, mints to the
    ///         caller, and creates each token's ERC-6551 account. IDs are
    ///         handed out lowest-first, skipping any ID that is reserved
    ///         or already minted (e.g. by the owner reserve). In the
    ///         Whitelist phase only allowlisted wallets can mint, up to
    ///         the per-wallet cap (wlPerWallet); in the Public phase
    ///         anyone can.
    function mint(uint256 quantity) external payable nonReentrant {
        require(mintPhase != MintPhase.Closed, "ApEd: mint is closed");
        require(quantity > 0, "ApEd: quantity is zero");
        require(totalMinted + quantity <= MAX_SUPPLY, "ApEd: supply cap reached");
        require(msg.value == mintPrice * quantity, "ApEd: wrong payment");
        if (mintPhase == MintPhase.Whitelist) {
            require(_whitelist[msg.sender], "ApEd: not whitelisted");
            require(wlMinted[msg.sender] + quantity <= wlPerWallet, "ApEd: whitelist cap reached");
            wlMinted[msg.sender] += quantity;
        }

        for (uint256 i = 0; i < quantity; i++) {
            uint256 tokenId = _claimNextPublicId();
            totalMinted++;
            _issueToken(msg.sender, tokenId);
        }
    }

    /// @notice Issue one token: register its ERC-8004 identity first
    ///         (when the Adapter and registry are configured), then
    ///         assign the token to its buyer, then create its ERC-6551
    ///         account. EVERY mint path — direct, whitelist, reserve,
    ///         SeaDrop — issues through here, so no path can skip the
    ///         registration. The order is Prem's confirmed design
    ///         (2026-11-17: "register then assign to the buyer"), and
    ///         it is the only order the Adapter's caller rules allow
    ///         this contract: the Adapter authorizes the token
    ///         contract itself only while the token has no owner (its
    ///         ownerless-registration path), so registration must run
    ///         before assignment. With no Adapter configured the
    ///         registration step is skipped and the mint behaves
    ///         exactly as a plain mint — configuration order at deploy
    ///         must never brick the mint; a token minted unregistered
    ///         can be registered later through the registerAgent
    ///         fallback (see its note on the delegation that then
    ///         applies).
    function _issueToken(address to, uint256 tokenId) internal {
        if (agentAdapter != address(0) && agentRegistry != address(0)) {
            _registerWithAdapter(tokenId, _agentURI(tokenId));
        }
        _safeMint(to, tokenId);
        _createTokenAccount(tokenId);
    }

    /// @notice The agent URI recorded with the Adapter at mint-time
    ///         registration: the token's own metadata route — the same
    ///         string tokenURI(tokenId) serves once the token exists
    ///         ({baseURI}{tokenId}). It is computed directly here
    ///         because ERC-721's tokenURI() requires an existing token
    ///         and registration runs before assignment. The metadata
    ///         service serves the agent's profile at this route (it
    ///         reads the recorded agentId back from this contract), so
    ///         the URI is the registration's profile pointer.
    function _agentURI(uint256 tokenId) internal view returns (string memory) {
        return string.concat(_baseTokenURI, Strings.toString(tokenId));
    }

    /// @notice Owner reserve mint. Designates one specific token ID as
    ///         reserved and mints it to pixel's wallet (the payout /
    ///         royalty address) at no charge, creating its ERC-6551
    ///         account exactly as a public mint does. At most MAX_RESERVE
    ///         (15) reserve mints ever; they count toward the 444 cap, so
    ///         a full reserve leaves 429 for the public mint. Works
    ///         whether or not the public mint is open — the reserve is
    ///         pixel's own set-aside, taken before or during the sale.
    ///         Which IDs are reserved is pixel's pick at call time; no ID
    ///         is hardcoded here.
    function reserveMint(uint256 tokenId) external onlyOwner nonReentrant {
        require(tokenId >= 1 && tokenId <= MAX_SUPPLY, "ApEd: invalid token id");
        require(reserveMinted < MAX_RESERVE, "ApEd: reserve exhausted");
        require(_ownerOf(tokenId) == address(0), "ApEd: token already minted");

        isReserved[tokenId] = true;
        reserveMinted++;
        totalMinted++;
        _issueToken(payoutAddress, tokenId);
        emit ReserveMinted(tokenId, payoutAddress);
    }

    /// @notice Claims the lowest token ID the public mint can still hand
    ///         out: the scan cursor advanced past every reserved or
    ///         already-minted ID. Reverts if none remain (the caller's
    ///         totalMinted check normally catches that first).
    function _claimNextPublicId() internal returns (uint256 tokenId) {
        tokenId = _nextTokenId;
        while (tokenId <= MAX_SUPPLY && (isReserved[tokenId] || _ownerOf(tokenId) != address(0))) {
            tokenId++;
        }
        require(tokenId <= MAX_SUPPLY, "ApEd: supply cap reached");
        _nextTokenId = tokenId + 1;
    }

    // ------------------------------------------------------------------
    // SeaDrop (OpenSea) — the sale's front door.
    //
    // The public sale runs through OpenSea's drop page: the SeaDrop
    // contract collects the buyer's payment, applies ITS OWN drop
    // phases and allowlist (configured on SeaDrop at drop setup), and
    // calls mintSeaDrop here to issue the tokens. Two doors, two
    // gatekeepers:
    //   - SeaDrop door (mintSeaDrop): gated by SeaDrop's drop config.
    //     This contract only checks that the caller is an owner-allowed
    //     SeaDrop contract, then enforces the same rules as every other
    //     mint path — mint price, lowest unreserved ID, 444 cap,
    //     ERC-6551 account per token. It deliberately does NOT consult
    //     this contract's own MintPhase or whitelist: SeaDrop has its
    //     own gating, and the custom phase being Closed must not block
    //     the OpenSea drop.
    //   - Direct door (mint): gated by this contract's MintPhase +
    //     whitelist, for a possible direct mint page.
    // The owner reserve is a separate owner-only path and cannot be
    // reached through SeaDrop.
    // ------------------------------------------------------------------

    /// @notice Mint via SeaDrop. Only callable by a SeaDrop contract the
    ///         owner has allowed (updateAllowedSeaDrop). Mints each
    ///         quantity to the matching recipient through the same
    ///         internal path as the direct mint: lowest available
    ///         unreserved ID, 444 cap across all paths, ERC-6551 account
    ///         created per token. Payment must cover mintPrice × total
    ///         quantity (a floor, not exact equality — SeaDrop forwards
    ///         value after its own fee handling; `minter` is the buyer
    ///         SeaDrop acted for and `feeRecipient` is where SeaDrop
    ///         routes its fees — both are recorded in the event, neither
    ///         changes what is minted here).
    function mintSeaDrop(
        address minter,
        address feeRecipient,
        address[] calldata mintRecipients,
        uint256[] calldata mintQuantities
    ) external payable nonReentrant {
        require(_allowedSeaDrop[msg.sender], "ApEd: caller is not an allowed SeaDrop");
        require(
            mintRecipients.length == mintQuantities.length,
            "ApEd: SeaDrop array length mismatch"
        );
        uint256 totalQuantity;
        for (uint256 i = 0; i < mintQuantities.length; i++) {
            totalQuantity += mintQuantities[i];
        }
        require(totalQuantity > 0, "ApEd: quantity is zero");
        require(totalMinted + totalQuantity <= MAX_SUPPLY, "ApEd: supply cap reached");
        require(msg.value >= mintPrice * totalQuantity, "ApEd: wrong payment");

        for (uint256 i = 0; i < mintRecipients.length; i++) {
            for (uint256 j = 0; j < mintQuantities[i]; j++) {
                uint256 tokenId = _claimNextPublicId();
                totalMinted++;
                _issueToken(mintRecipients[i], tokenId);
            }
        }
        emit SeaDropMinted(msg.sender, minter, feeRecipient, totalQuantity);
    }

    /// @notice Allow or disallow SeaDrop contracts to call mintSeaDrop.
    ///         Owner-only. Setting `allowed` true adds each listed
    ///         address (duplicates are ignored); false removes them.
    function updateAllowedSeaDrop(
        address[] calldata allowedSeaDrop,
        bool allowed
    ) external onlyOwner {
        for (uint256 i = 0; i < allowedSeaDrop.length; i++) {
            address seaDrop = allowedSeaDrop[i];
            if (allowed && !_allowedSeaDrop[seaDrop]) {
                _allowedSeaDrop[seaDrop] = true;
                _enumeratedAllowedSeaDrop.push(seaDrop);
            } else if (!allowed && _allowedSeaDrop[seaDrop]) {
                _allowedSeaDrop[seaDrop] = false;
                for (uint256 j = 0; j < _enumeratedAllowedSeaDrop.length; j++) {
                    if (_enumeratedAllowedSeaDrop[j] == seaDrop) {
                        _enumeratedAllowedSeaDrop[j] =
                            _enumeratedAllowedSeaDrop[_enumeratedAllowedSeaDrop.length - 1];
                        _enumeratedAllowedSeaDrop.pop();
                        break;
                    }
                }
            }
            emit AllowedSeaDropUpdated(seaDrop, allowed);
        }
    }

    /// @notice The SeaDrop contracts currently allowed to mint here.
    function getAllowedSeaDrop() external view returns (address[] memory) {
        return _enumeratedAllowedSeaDrop;
    }

    /// @notice Whether one address is an allowed SeaDrop contract.
    function isAllowedSeaDrop(address seaDrop) external view returns (bool) {
        return _allowedSeaDrop[seaDrop];
    }

    // ------------------------------------------------------------------
    // ERC-6551 token-bound accounts
    // ------------------------------------------------------------------

    /// @notice The deterministic ERC-6551 account address for a token.
    ///         Exists (as an address) whether or not it has been deployed.
    function tokenAccount(uint256 tokenId) public view returns (address) {
        return IERC6551Registry(ERC6551_REGISTRY).account(
            ERC6551_IMPLEMENTATION,
            block.chainid,
            address(this),
            tokenId,
            TBA_SALT
        );
    }

    /// @notice Permissionless helper: deploy the token's ERC-6551 account if
    ///         it does not exist yet. Idempotent — the registry returns the
    ///         existing account if it was already created (e.g. at mint).
    function ensureTokenAccount(uint256 tokenId) external returns (address) {
        require(_ownerOf(tokenId) != address(0), "ApEd: token does not exist");
        return _createTokenAccount(tokenId);
    }

    function _createTokenAccount(uint256 tokenId) internal returns (address account) {
        account = IERC6551Registry(ERC6551_REGISTRY).createAccount(
            ERC6551_IMPLEMENTATION,
            block.chainid,
            address(this),
            tokenId,
            TBA_SALT
        );
        // ERC-721T: record the ape's own account on Base in its onchain
        // profile, under the profile's Base address key. Every mint path
        // (direct, whitelist, reserve, SeaDrop) funnels through here, so
        // every minted ape carries the record from birth.
        _setMetadata(tokenId, BASE_ADDRESS_KEY, abi.encodePacked(account));
    }

    // ------------------------------------------------------------------
    // ERC-8004 agent registration, through Adapter8004. Registration
    // normally happens INSIDE the mint (see _issueToken): the Adapter
    // binds the token under the ERC-721 standard (0) and has the
    // Identity Registry mint the identity NFT to ITSELF — the Adapter
    // custodies the identity, and control of the record is re-derived
    // from the token's current owner on every call. The identity
    // therefore cannot be transferred out of the ape's wallet or
    // stripped ahead of a sale — it is not in the wallet at all; it
    // stays bound to the token, and whoever holds the token controls
    // it. The ape's ERC-6551 wallet is unchanged: it holds the ape's
    // trading funds, as before.
    // ------------------------------------------------------------------

    /// @notice Fallback registration for a token that was minted
    ///         BEFORE the Adapter was configured (so its mint carried
    ///         no registration). Owner-only, once per token. Tokens
    ///         minted with the Adapter configured are already
    ///         registered at mint and revert here as already
    ///         registered.
    /// @dev Caller authority on the Adapter's side — the Adapter's
    ///      rule, not ours: post-mint, the Adapter authorizes a
    ///      register() caller only if it is the token's current owner
    ///      or that owner's delegate.xyz delegate
    ///      (adapter8004.manage). This call reaches the Adapter with
    ///      THIS CONTRACT as the caller, so on the real deployment it
    ///      succeeds only when the token's current owner has granted
    ///      this contract that delegation; without it the Adapter
    ///      rejects the call and this function reverts with the
    ///      Adapter's error. That is exactly why registration lives in
    ///      the mint: at mint time this contract registers on the
    ///      Adapter's ownerless path, which needs no delegation.
    function registerAgent(uint256 tokenId, string calldata agentURI) external onlyOwner returns (uint256 agentId) {
        require(agentAdapter != address(0), "ApEd: agent adapter not set");
        require(agentRegistry != address(0), "ApEd: agent registry not set");
        require(_ownerOf(tokenId) != address(0), "ApEd: token does not exist");
        require(agentIdOf[tokenId] == 0, "ApEd: agent already registered");
        agentId = _registerWithAdapter(tokenId, agentURI);
    }

    /// @notice The one registration path both the mint and the
    ///         registerAgent fallback run: call the Adapter, record
    ///         the returned agentId against the token, and write the
    ///         token's ERC-721T agent-registration record.
    function _registerWithAdapter(uint256 tokenId, string memory agentURI) internal returns (uint256 agentId) {
        agentId = IAdapter8004(agentAdapter).register(
            ADAPTER_STANDARD_ERC721,
            address(this),
            tokenId,
            agentURI
        );
        agentIdOf[tokenId] = agentId;
        // ERC-721T: record the registration in the token's own onchain
        // profile, under the agent-registration key in the exact
        // ENSIP-25 format: "agent-registration[<registry>][<agentId>]"
        // with <registry> as its ERC-7930 interoperable address. Per
        // ENSIP-25 the value carries no semantics beyond being
        // non-empty (its presence is the attestation), so the value is
        // "1" as that standard recommends.
        _setMetadata(
            tokenId,
            string.concat(
                "agent-registration[",
                Strings.toHexString(_erc7930Address(agentRegistry)),
                "][",
                Strings.toString(agentId),
                "]"
            ),
            bytes("1")
        );
        emit AgentRegistered(tokenId, agentId);
    }

    /// @notice The ERC-7930 Interoperable Address of an account on this
    ///         chain: version 0x0001, EIP-155 chain type 0x0000, the
    ///         chain ID in minimal big-endian bytes, a 0x14 length byte
    ///         (20-byte address), then the address itself. Used to name
    ///         the ERC-8004 registry inside the agent-registration key.
    function _erc7930Address(address account) internal view returns (bytes memory) {
        bytes32 chainId = bytes32(block.chainid);
        uint256 first = 0;
        while (first < 31 && chainId[first] == 0) {
            first++;
        }
        bytes memory chainRef = new bytes(32 - first);
        for (uint256 i = 0; i < chainRef.length; i++) {
            chainRef[i] = chainId[first + i];
        }
        return abi.encodePacked(bytes2(0x0001), bytes2(0x0000), chainRef, bytes1(0x14), account);
    }

    // ------------------------------------------------------------------
    // ERC-8048 onchain metadata — the ERC-721T agent profile
    //
    // Each token carries a key/value store on this contract. Two records
    // are written automatically: the token's ERC-6551 account under the
    // Base address key at mint (every path), and its ERC-8004
    // registration under the agent-registration key at registration —
    // which is part of the mint itself when the Adapter is configured.
    // The profile's `context` and `endpoint[<type>]` keys are
    // deliberately left unset at mint (gas); they are populated per
    // token afterwards through setMetadata. Per EIP-8048, the profile
    // keys live ONLY here onchain — never in the tokenURI JSON; clients
    // read them with metadata(tokenId, key).
    // ------------------------------------------------------------------

    /// @notice ERC-8048 getter: the value stored under `key` for
    ///         `tokenId`, or empty bytes when nothing is stored there.
    function metadata(uint256 tokenId, string calldata key)
        external
        view
        override
        returns (bytes memory)
    {
        return _tokenMetadata[tokenId][key];
    }

    /// @notice ERC-8048 setter (the ERC leaves the write policy to the
    ///         contract; this is ours): the contract owner (the issuer)
    ///         and the token's current owner may write that token's
    ///         records — nobody else, approved operators included. Write
    ///         access follows the token: after a sale the new owner
    ///         writes and the previous owner no longer can.
    function setMetadata(uint256 tokenId, string calldata key, bytes calldata value) external {
        require(
            msg.sender == owner() || msg.sender == _ownerOf(tokenId),
            "ApEd: not a metadata writer for this token"
        );
        _setMetadata(tokenId, key, value);
    }

    function _setMetadata(uint256 tokenId, string memory key, bytes memory value) internal {
        _tokenMetadata[tokenId][key] = value;
        emit MetadataSet(tokenId, key, key, value);
        // ERC-4906: every value write signals a metadata refresh. All
        // writes funnel through here — the mint-time address record,
        // the registerAgent registration record, and later setMetadata
        // changes alike — so post-mint changes (context, endpoints)
        // are picked up by OpenSea instead of going stale in its cache.
        emit MetadataUpdate(tokenId);
    }

    // ------------------------------------------------------------------
    // Owner controls
    // ------------------------------------------------------------------

    /// @notice Set the mint phase: Closed, Whitelist, or Public.
    function setMintPhase(MintPhase phase) external onlyOwner {
        mintPhase = phase;
        emit MintPhaseSet(phase);
    }

    /// @notice The original open/closed toggle, kept as a convenience:
    ///         true opens the Public phase, false closes the mint.
    function setMintOpen(bool open) external onlyOwner {
        mintPhase = open ? MintPhase.Public : MintPhase.Closed;
        emit MintPhaseSet(mintPhase);
        emit MintOpened(open);
    }

    // ------------------------------------------------------------------
    // Whitelist — the owner-managed allowlist for the Whitelist phase.
    // The campaign collects addresses off-chain (pixel-controlled
    // records); the owner loads them here so the phase is enforced
    // on-chain, in the contract itself.
    // ------------------------------------------------------------------

    function addToWhitelist(address[] calldata wallets) external onlyOwner {
        for (uint256 i = 0; i < wallets.length; i++) {
            _whitelist[wallets[i]] = true;
            emit WhitelistAdded(wallets[i]);
        }
    }

    function removeFromWhitelist(address[] calldata wallets) external onlyOwner {
        for (uint256 i = 0; i < wallets.length; i++) {
            _whitelist[wallets[i]] = false;
            emit WhitelistRemoved(wallets[i]);
        }
    }

    function isWhitelisted(address wallet) external view returns (bool) {
        return _whitelist[wallet];
    }

    /// @notice Set the per-wallet mint cap for the Whitelist phase.
    function setWlPerWallet(uint256 cap) external onlyOwner {
        wlPerWallet = cap;
        emit WlPerWalletSet(cap);
    }

    function setMintPrice(uint256 priceWei) external onlyOwner {
        mintPrice = priceWei;
        emit MintPriceSet(priceWei);
    }

    function setBaseURI(string calldata baseURI) external onlyOwner {
        _baseTokenURI = baseURI;
        emit BaseURISet(baseURI);
    }

    function setAgentRegistry(address registry) external onlyOwner {
        agentRegistry = registry;
        emit AgentRegistrySet(registry);
    }

    function setAgentAdapter(address adapter) external onlyOwner {
        agentAdapter = adapter;
        emit AgentAdapterSet(adapter);
    }

    /// @notice Change the ERC-2981 default royalty (receiver + rate).
    function setDefaultRoyalty(address receiver, uint96 bps) external onlyOwner {
        _setDefaultRoyalty(receiver, bps);
    }

    /// @notice Withdraw all mint proceeds to pixel's wallet.
    function withdraw() external onlyOwner nonReentrant {
        uint256 amount = address(this).balance;
        require(amount > 0, "ApEd: nothing to withdraw");
        (bool ok, ) = payable(payoutAddress).call{value: amount}("");
        require(ok, "ApEd: withdraw failed");
        emit ProceedsWithdrawn(payoutAddress, amount);
    }

    // ------------------------------------------------------------------
    // Metadata
    // ------------------------------------------------------------------

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    /// @dev ERC721's default tokenURI appends the decimal tokenId to the
    ///      base URI, so the metadata service should serve
    ///      {baseURI}1 .. {baseURI}444 (IPFS pointers to the pinned art).

    // ------------------------------------------------------------------
    // Interface support (ERC-721 + ERC-2981 + the SeaDrop token surface
    // + ERC-8048 + ERC-4906)
    // ------------------------------------------------------------------
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC2981)
        returns (bool)
    {
        return
            interfaceId == type(ISeaDropToken).interfaceId ||
            interfaceId == 0xdf670be1 || // ERC-8048 (IERC8048Metadata), per EIP-8048
            interfaceId == 0x49064906 || // ERC-4906 (metadata-update signalling)
            super.supportsInterface(interfaceId);
    }
}
