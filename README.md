# ApEd — collection contract

`contracts/ApEdApes.sol` is the mint contract for the ApEd collection: 444
agent apes on Base, built on the same chassis as the live SwampAgentsV2
(ERC-721 + ERC-6551 + ERC-8004). Design source: `../BUILD-BOOK.md` §1, §2, §7.

**Status: DEPLOYED to Base mainnet 2026-11-18.
Contract: `0x916A50f2d7374d56C3964eFb706F10909fFeEF01`. Owner: the
project wallet. Mint phase: Closed — the mint opens only when the
project sets a date and opens a phase.**

## What the contract does

- **ERC-721, hard cap 444.** Token IDs run 1–444. The cap is enforced in
  code; a 445th mint always reverts.
- **Mint phases: Closed → Whitelist → Public.** The mint starts Closed;
  only the owner moves it between phases (`setMintPhase`). The original
  `setMintOpen` toggle is kept as a convenience (true = Public phase,
  false = Closed), and `mintOpen()` still reports whether minting is live
  in any phase. Price is owner-settable in wei (`setMintPrice`); a mint
  must pay exactly `price × quantity` or it reverts, in every phase.
- **Every mint creates the token's ERC-6551 token-bound account** through the
  canonical registry `0x000000006551c19487814612e58FE06813775758` with the
  confirmed implementation `0x9d8Ee22f8E09965cb97faF6AeAB11b8B4098D5Ec`
  (5-argument `createAccount`, salt 0 — the same configuration as
  SwampAgentsV2). `tokenAccount(id)` returns the deterministic wallet
  address for any token, and `ensureTokenAccount(id)` is a permissionless,
  idempotent helper that deploys the account if it is ever missing.
- **ERC-8004 agent registration — through Adapter8004, inside the
  mint.** Registration is part of issuance: every mint path (direct,
  whitelist, reserve, SeaDrop) funnels through one internal issue
  step that first calls the Adapter's
  `register(0, address(this), tokenId, agentURI)`, records the
  returned agentId against the token (`agentIdOf`), and writes the
  token's ERC-721T agent-registration record (see the next bullet) —
  and only then assigns the token to its buyer and creates its
  ERC-6551 account. The order is **Prem's confirmed design
  (2026-11-17, reviewing this contract: "register then assign to the
  buyer")**. The agent URI recorded at mint points at the metadata
  service's dedicated **agent route** (`{agentBaseURI}{tokenId}`) —
  the route serving the token's ERC-8004 agent file, which mirrors
  the token's on-chain ERC-721T profile (endpoints included). The
  URI points back at a link the project controls, so the ERC-8004
  agent metadata behind it can be updated without touching the
  chain (**Prem's suggestion, 2026-11-17**, reviewing this
  contract). The agent base URI is an owner-settable deployment
  parameter (constructor or `setAgentBaseURI`); while it is unset,
  the recorded agent URI falls back to the token's own metadata
  route (`{baseURI}{tokenId}` — the same string `tokenURI`
  serves), so an unconfigured deploy behaves exactly as before.
  The Adapter
  binds the token under its ERC-721 standard (standard 0 — control
  follows `ownerOf`) and has the Identity Registry mint the identity
  NFT to the Adapter itself, which custodies it. Control of the
  identity record is re-derived from the token's current owner on
  every call, so the identity can never be transferred out of the
  ape's wallet or stripped ahead of a sale — it is never in the
  wallet at all; it stays bound to the token and passes to whoever
  holds the token. The ERC-6551 wallet leg is unchanged — the wallet
  still holds the ape's trading funds; what travels with the token is
  the wallet address, the identity, and the record, and the funds in
  the wallet remain the current owner's working capital.
  Registration at mint runs only when the Adapter and the registry
  are configured: a mint with no Adapter set skips registration and
  behaves exactly as a plain mint (deploy configuration order must
  never brick the mint), and `registerAgent(tokenId, agentURI)`
  (owner-only) remains as the fallback for such a token — see the
  caller-authority note for the delegation that fallback then needs.
  If the Adapter IS configured, its call is integral to the mint: an
  Adapter failure reverts the mint rather than issuing an
  unregistered ape. Adopted 2026-11-17 on pixel's ruling ("I say we
  let them register") — the same adapter-mediated pattern pixel
  already runs for his Loopers and Swamp Agents — after Prem's
  critique of holding the identity inside the drainable wallet.
  Accepted dependency, recorded plainly: the Adapter is a young
  (v0.0.x), Unruggable-upgradeable UUPS proxy with internal/AI-
  orchestrated reviews only and no published third-party audit
  (research:
  `~/workspace/research_notes/adapter-vs-6551-20261117/report.md`).
  Covered by the tests "registers the agent inside the mint — before
  the buyer owns the token", "mint binds the token through the
  Adapter under the ERC-721 standard, agent URI = the token's
  metadata route", "registers on every mint path — whitelist,
  reserve, and SeaDrop included", and "the Adapter custodies the
  ERC-8004 identity — not the ape's wallet, not the contract".
- **Caller authority — the design now runs on the Adapter's
  ownerless path.** The Adapter authorizes the caller of its
  `register()` under its binding rules: the token contract itself
  only while the token has no owner (its ownerless-registration
  path, designed for binding inside the mint transaction), otherwise
  the token's current owner or that owner's delegate.xyz delegate
  (`adapter8004.manage`). Mint-time registration is built to the
  first rule by construction — the call runs before assignment, so
  no delegation is ever needed for a normally minted ape. The rule
  binds only the `registerAgent` **fallback**: for a token minted
  before the Adapter was configured, the fallback call reaches the
  Adapter with this contract as the caller, so it succeeds only when
  the token's current owner has granted this contract the
  `adapter8004.manage` delegation via delegate.xyz; without it the
  Adapter rejects the call. That is the Adapter's model working as
  intended — it deliberately gives the original registrant no
  lasting privilege — and it is why registration lives in the mint
  rather than after it.
- **ERC-721T onchain agent profile (ERC-8048).** Every token carries a
  key/value metadata store on the contract itself (`metadata(tokenId,
  key)` / `setMetadata`, ERC-165 ID `0xdf670be1`), holding its ERC-721T
  agent profile: at mint, on every mint path, the token's ERC-6551
  account address is written under the Base address key, and the
  ERC-8004 registration (itself part of the mint) is written under the
  agent-registration key. `context` and endpoint keys are set per token
  afterwards. See the ERC-721T section below. Added 2026-11-17 on
  pixel's "Do it or add it. Yes".
- **ERC-2981 royalties.** Default royalty is set in the constructor and can
  be updated by the owner (`setDefaultRoyalty`). The receiver is pixel's
  wallet (see below).
- **Metadata.** `tokenURI` is the owner-settable base URI plus the token ID
  (`{baseURI}1` … `{baseURI}444`). The base URI points at the metadata
  service's per-token route (see the Base URI deploy parameter below), and
  the JSON the service returns for each token carries that token's portrait
  as its own per-token `ipfs://<CID>` pointer — the art is pinned on
  Filebase, and the filename→CID mapping lives in
  `~/workspace/mutant-fleet/out/image-cids.json`.
- **Proceeds.** Mint payments accumulate in the contract; `withdraw()`
  (owner-only) sends the full balance to pixel's wallet.
- **Owner reserve — 15 pieces for pixel himself.** `reserveMint(tokenId)`
  (owner-only) designates one specific token ID as reserved and mints it
  to pixel's wallet (the payout / royalty address) at no charge, creating
  its ERC-6551 account exactly as a public mint does. It works whether or
  not the public mint is open. The cap is 15 reserve mints ever
  (`MAX_RESERVE`); a 16th reverts. Which IDs are reserved is pixel's pick
  at call time — no ID is hardcoded. Reserve mints count toward the 444
  cap and the public mint skips reserved (and already-minted) IDs,
  handing out the lowest available ID, so at full reserve the public
  supply is **429** and the combined total can never pass 444. Added
  2026-11-17 on pixel's order.
- **Whitelist — enforced on-chain.** During the Whitelist phase only
  allowlisted wallets can mint, at the same mint price, up to a per-wallet
  cap (`wlPerWallet`, default 1, owner-settable via `setWlPerWallet`).
  The owner manages the list in batches with `addToWhitelist(address[])`
  and `removeFromWhitelist(address[])`; `isWhitelisted(address)` is the
  public check, and each wallet's whitelist-phase mints are tracked in
  `wlMinted` (removing a wallet does not reset its count). The owner
  reserve is unaffected and works in any phase. The campaign itself still
  runs off-chain — addresses are collected into pixel-controlled records
  and the owner loads them into the contract — but the gate is the
  contract, not a front end. Added 2026-11-17 on pixel's ruling.
- **SeaDrop — the sale's front door is OpenSea.** Buyers mint on OpenSea's
  drop page; the SeaDrop contract calls `mintSeaDrop` here to issue the
  tokens through the same internal mint path as the direct mint. See the
  SeaDrop section below.
- **No breeding.** Gen-1 breeding (BUILD-BOOK §12) is deliberately not in
  this version; babies are a later addition.

## SeaDrop — the OpenSea front door

Pixel's ruling (2026-11-17): buyers will not trust connecting a wallet to
an unknown site, so the sale is sold through OpenSea's drop page and this
contract is the engine underneath. OpenSea's SeaDrop contract collects
the buyer's payment, applies the drop's phases and allowlist, and calls
`mintSeaDrop` on this contract to issue the tokens.

**What this contract exposes** (declared locally as `ISeaDropToken`;
`supportsInterface` reports its ERC-165 interface ID):

- `mintSeaDrop(minter, feeRecipient, mintRecipients, mintQuantities)`
  (payable) — callable only by a SeaDrop contract the owner has allowed.
  Mints each quantity to the matching recipient through the same internal
  path as the direct mint: lowest available unreserved ID, the 444 cap
  across all mint paths combined, and an ERC-6551 account created per
  token. Payment must cover `mintPrice × total quantity` — a floor, not
  exact equality, because SeaDrop forwards value after its own fee
  handling (the direct `mint()` keeps its exact-payment rule).
- `updateAllowedSeaDrop(address[], bool)` — owner-only; adds or removes
  the SeaDrop contracts allowed to call `mintSeaDrop`.
- `getAllowedSeaDrop()` / `isAllowedSeaDrop(address)` — read the allowlist.

**Which system governs which door:**

- **SeaDrop door (the sale):** the drop's phases, allowlist stages, and
  timing live in the SeaDrop contract's drop configuration, set up on
  SeaDrop at drop creation. `mintSeaDrop` deliberately does **not**
  consult this contract's `MintPhase` or its whitelist — SeaDrop has its
  own gating, and the custom phase being Closed does not block the
  OpenSea drop.
- **Direct door (kept, unused by the OpenSea sale):** `mint()` is governed
  by this contract's own `MintPhase` + whitelist system, for a possible
  direct mint page or fallback.
- **Reserve door:** `reserveMint` stays owner-only and cannot be reached
  through SeaDrop; SeaDrop mints skip reserved IDs like every other
  public path.

**Implementation note — why not full ERC721SeaDrop inheritance:**
upstream `ERC721SeaDrop` (ProjectOpenSea/seadrop) is built on ERC721A +
SeaDrop's own `ERC721ContractMetadata` — a different token base than this
contract's OpenZeppelin v5 ERC721 + ERC2981. Inheriting it would have
meant replacing the token base and rewriting the existing mint logic
(reserve, phases, ERC-6551 / ERC-8004 wiring). Instead, this contract
implements the SeaDrop token interface surface that SeaDrop actually
calls on a creator-owned token contract — `mintSeaDrop`,
`updateAllowedSeaDrop`, `getAllowedSeaDrop` — and routes it into the
existing internal mint path. The declared interface is that subset, so
its ERC-165 ID is the ID of the subset, documented here as such.

**⚠️ Deploy-time — no SeaDrop address is hardcoded, on purpose.** Nothing
in this contract names a SeaDrop address. At deploy time, verify the real
SeaDrop contract address **for Base** from OpenSea's official SeaDrop
deployment records — the well-known mainnet SeaDrop address must not be
assumed to be the Base one — then register it with
`updateAllowedSeaDrop([<Base SeaDrop address>], true)` before configuring
the drop. Until an address is registered, `mintSeaDrop` rejects every
caller. Added 2026-11-17 on pixel's ruling.
**Verified for Base 2026-11-18:** SeaDrop 1.0 sits at
`0x00005EA00Ac477B1030CE78506496e8C2dE24bf5` on Base — OpenSea's own
SeaDrop repo gives that address for SeaDrop 1.0 and BaseScan lists it as
"OpenSea: SeaDrop 1.0" with live mint traffic. That is the address to
register at deploy; the contract still names none.

## ERC-721T onchain agent metadata (ERC-8048)

ERC-8048 gives every token its own on-chain key/value store on the token
contract, read with one call — `metadata(tokenId, key)` returns the bytes
stored under that key (empty bytes when unset) — and every write emits
`MetadataSet`, an on-chain audit trail. ERC-721T is the Agent Metadata
Profile defined inside ERC-8048: a reserved set of those keys for tokens
that are agents — `context` (the agent's context document), `endpoint[<type>]`
(its MCP / A2A / web / x402 endpoints, canonical lowercase types),
`address[<chain-id>]` (the agent's account on a chain, the chain named by
its ERC-7930 Chain Identifier), and the ENSIP-25 agent-registration key
below. The profile defines no interface of its own; detection is
ERC-8048's ERC-165 ID, `0xdf670be1`, which `supportsInterface` now
reports alongside ERC-721, ERC-2981, and the SeaDrop token surface.

**Implementation.** The interface is declared locally in `ApEdApes.sol`
and implemented following the EIP's own reference implementation — the
installed `@openzeppelin/contracts` v5.6.1 ships no ERC-8048
implementation to inherit. The optional Metadata Authority extension
(`tokenMetadataAuthority()`, ID `0x04f90b41`) is **not** implemented;
ERC-8048 leaves the write policy to the contract when no authority is
set, and ours is per-token (below). That is the one place this build
takes an option the standard offers rather than the whole menu.

**Keys written automatically:**

| When | Key | Value | Written by |
|---|---|---|---|
| Every mint — direct, whitelist, reserve, and SeaDrop paths alike (all funnel through the same account-creation step) | `address[0x0001000002210500]` — the `address[<chain-id>]` key for Base (chain ID 8453; `0x0001000002210500` is its ERC-7930 Chain Identifier, the exact form in EIP-8048's own Base example) | The token's ERC-6551 account on Base: the raw 20 address bytes (the ERC-7930 Address component, not a full interoperable address) | The contract itself, at mint |
| Registration, inside every mint (and the `registerAgent` fallback) | `agent-registration[<registry>][<agentId>]` — `<registry>` is the configured ERC-8004 registry as an ERC-7930 interoperable address (e.g. on Base, `0x00010000022105` + `14` + the registry address, hex), `<agentId>` the issued ID in decimal — the exact key format ENSIP-25 defines | `"1"` (UTF-8). Per ENSIP-25 the value has no semantics beyond being non-empty — its presence is the attestation — and `"1"` is the value that standard recommends | The contract itself, inside the registration step of the mint |

**Keys left unset at mint, on purpose (gas):** `context` and every
`endpoint[<type>]` key. They are populated per token afterwards through
`setMetadata` — e.g. the owner writes a token's `context` once its agent
profile is written, and an endpoint when the ape's MCP/A2A/web endpoint
goes live.

**Write permissions (`setMetadata`).** The contract owner (the issuer)
and the token's current owner can write that token's records; nobody
else can — approved operators and `getApproved` addresses included
(deliberately narrower than ERC-721 transfer approvals). Write access
follows the token: after a sale, the new owner writes and the previous
owner no longer can. The automatic records (address key,
agent-registration key) are written by the contract itself and can be
overwritten later by either authorized writer like any other record.

**How OpenSea reads these values.** Per OpenSea's metadata docs, a field
in a token's JSON can be an `onchain:` URI (the ERC-8493 draft form):
OpenSea then calls `metadata(tokenId, key)` on this contract and uses
the returned bytes as that field's value — a top-level field reads the
key named after it, and `?key=` names a different key (e.g. an attribute
value of `"onchain:?key=context"`). Because the records live on this
contract, no `metadata_contract` sidecar is needed. Two cautions from
the same docs and from EIP-8048 itself: the ERC-721T profile keys MUST
NOT also be duplicated as members of the tokenURI JSON (clients read
them on-chain and must ignore JSON members with these names), so the
metadata service should expose them only through `onchain:` fields if it
exposes them in JSON at all. On refresh: OpenSea re-reads changed values
when the contract emits the ERC-4906 `MetadataUpdate` event, and this
contract does — every ERC-8048 write funnels through one internal
helper that emits `MetadataUpdate(tokenId)` alongside `MetadataSet`,
and `supportsInterface` advertises ERC-4906 (`0x49064906`). The
mint-time and registration writes emit it too (harmless — OpenSea has
nothing cached yet); the writes that matter for refresh are the
post-mint `setMetadata` changes, such as a token's `context` or
endpoint records being added later. Added 2026-11-17, per OpenSea's
metadata docs (updated 2026-11-12): "When you change a stored value,
emit ERC-4906 MetadataUpdate for the token so OpenSea refreshes it."

**Gas note.** On-chain records are not free: each mint now also pays for
two fresh storage writes (the 20-byte address record and, when the
Adapter is configured, the agent-registration record) plus their
`MetadataSet` and `MetadataUpdate` events, and — with the Adapter
configured — the Adapter/registry registration calls themselves (the
registry mints the identity NFT to the Adapter inside the same
transaction). That is a fixed addition per mint — the price of the
profile and the identity living on the token instead of only on our
server — and it is why `context` and the endpoint keys are not
written at mint. (In the local suite it is also why the 444-cap tests
batch their mints at 25 per transaction: the local network's block
gas limit, not a contract limit.)

## ⚠️ Deploy parameters — pixel decides every one of these

| Parameter | What it is | Status |
|---|---|---|
| **Royalty bps** | The ERC-2981 royalty rate in basis points (e.g. 1000 = 10%). Paid to pixel's wallet `0x4f9883c7331ba59a56360ffa3c332e0bc09029fc` on every secondary sale. | **DECIDED — 1500 bps (15%), set by pixel 2026-11-17.** Pass 1500 as `_royaltyBps` at deploy. The tests use 1000 bps as a placeholder only. |
| **Mint price (wei)** | The $7 mint price converted to ETH. The contract takes wei, not dollars — no exchange rate is hardcoded anywhere. | Pixel sets the ETH figure at deploy time, from the ETH price that day. Owner can re-price later with `setMintPrice`. |
| **Base URI** | The metadata service's per-token route. `tokenURI(id)` is `{baseURI}{id}`, and the base URI is set to the deployed metadata service's metadata route — `https://pixeldregsz-cmyk.github.io/aped-metadata/metadata/` (live since 2026-11-18; static launch mode on GitHub Pages) — so each token's URI is the service's per-token route for that ID. The JSON served there carries the token's portrait as a per-token `ipfs://<CID>` pointer (the filename→CID mapping is `~/workspace/mutant-fleet/out/image-cids.json`, bound into the service; see the "CID binding" section of the metadata service README). | Set at deploy; owner can change it later with `setBaseURI`. |
| **Agent base URI** | The metadata service's AGENT-route base — `https://pixeldregsz-cmyk.github.io/aped-metadata/agent/` (live since 2026-11-18, same static deployment). The agentURI recorded with the Adapter at mint-time registration is `{agentBaseURI}{tokenId}`: the route serving the token's ERC-8004 agent file (which mirrors the token's ERC-721T profile), on a link the project controls so the agent metadata can be updated without touching the chain (Prem's suggestion, 2026-11-17). | Constructor parameter `_agentBaseURI`. May be deployed empty — the recorded agentURI then falls back to the token's metadata route (`{baseURI}{tokenId}`) — and set later with `setAgentBaseURI`. For agentURIs to point at the agent file from the first mint, set it before the mint opens. |
| **ERC-8004 registry address** | The ERC-8004 Identity Registry on Base. The Adapter is configured against this registry — its registrations return registry agentIds — and registration names it in the token's ERC-721T agent-registration key. Like the Adapter, it must be set before the mint opens for identities to be filed at mint. | Constructor parameter `_agentRegistry`. **Verified on Base 2026-11-18:** `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` — bytecode present and its `name()` returns "AgentIdentity". May be deployed as `address(0)` and set later with `setAgentRegistry`. |
| **Adapter8004 address** | The Adapter proxy the mint-time registration calls to register identities — the custody + binding layer for the identity leg (see the registration bullet above). **It must be set before the mint opens if identities are to be filed at mint** (constructor, or `setAgentAdapter` before opening); tokens minted before it is set carry no registration and fall back to `registerAgent` + the owner's delegate.xyz grant. | Constructor parameter `_agentAdapter`; owner can set or change it later with `setAgentAdapter`. **Verified on Base 2026-11-18:** `0x270d25D2c59A8bcA1B0f40ad95fF7806c0025c27` — bytecode present (UUPS proxy). Cross-check once more against Unruggable's published deployments table at deploy. |

Fixed in code (not parameters): supply cap 444, the ERC-6551 registry and
implementation addresses above, royalty receiver and proceeds payout =
pixel's wallet `0x4f9883c7331ba59a56360ffa3c332e0bc09029fc`.

## Deploy sequence (when pixel gives the word — not before)

1. Pixel decides the parameters in the table above.
2. Confirm the final cast: all 444 portraits finished, token assignment and
   the rarity table computed and locked (BUILD-BOOK §7), art pinned on
   Filebase (no Pinata mirror — that account is pixel's own and the mirror
   is parked; nothing depends on it), metadata service serving
   `{baseURI}{id}`.
3. Deploy `ApEdApes` to Base from pixel's wallet (he becomes owner) with the
   constructor parameters.
4. Verify the contract source on BaseScan.
5. Sanity-check on-chain: mint is closed, price reads correctly,
   `tokenAccount(1)` returns a sane address, `royaltyInfo` returns pixel's
   wallet at the chosen rate, `supportsInterface(0xdf670be1)` reads
   true (the ERC-8048 store is live), and `supportsInterface(0x49064906)`
   reads true (ERC-4906 signalling is live).
6. **Set the Adapter and the registry before any mint opens** (constructor
   parameters at step 3, or `setAgentAdapter` / `setAgentRegistry`
   afterwards), **and the agent base URI** (constructor parameter
   `_agentBaseURI`, or `setAgentBaseURI` afterwards) so the agentURI
   recorded at mint points at the metadata service's agent route from
   the first mint — registration rides inside the mint, in Prem's confirmed
   order (register, then assign to the buyer), so an ape minted before
   the Adapter is set is an ape with no identity filed. Such a token can
   still be registered later through the `registerAgent` fallback, but
   only once its owner has granted this contract the `adapter8004.manage`
   delegation via delegate.xyz (see the caller-authority note above) —
   avoid needing it. Note the gas shape of the sale: every mint
   transaction now also writes the token's on-chain ERC-721T records (the
   address record, and the agent-registration record when the Adapter is
   configured) and, with the Adapter configured, runs the registration
   calls themselves — budget gas accordingly; see the ERC-721T section's
   gas note.
7. SeaDrop setup (the sale's front door): verify the real SeaDrop
   contract address for Base from OpenSea's official SeaDrop deployment
   records — do not assume the mainnet address — register it with
   `updateAllowedSeaDrop([<address>], true)`, then create and configure
   the drop on SeaDrop (price, phases, allowlist stages) and point the
   OpenSea drop page at this contract. The drop's phases and allowlist
   live in that SeaDrop configuration, not in this contract's `MintPhase`.
8. Only if a direct mint page is ever run as a second door: load the
   whitelist (`addToWhitelist`), open the Whitelist phase
   (`setMintPhase(1)`), then the Public phase (`setMintPhase(2)`). Per
   the project's launch route, the mint runs first; the token launch
   follows, seeded by the mint proceeds.

## Tests

Toolchain: Hardhat 2 + ethers v6 + OpenZeppelin Contracts v5, solc 0.8.28
(Cancun). Run from this folder:

```
npm install
npx hardhat test
```

43 tests, all passing. They cover: mint closed by default and rejecting
mints; owner-only mint toggle; exact-price charging (underpay and
wrong-quantity payment revert); owner re-pricing; the 444 cap (444 mint
fine, 445th reverts); ERC-6551 account creation at mint with the address
matching the registry's own derivation and code present at the address;
the permissionless account helper's idempotency; tokenURI from the base
URI; `royaltyInfo` returning pixel's wallet; ERC-8004 registration
through the Adapter, inside the mint — the agentId recorded by the
time the mint lands, the mock Adapter (which enforces the real
Adapter's caller-authority rule) recording that the token had NO
owner at registration time and the buyer owning it only afterwards, a
multi-mint registering in token order, the Adapter being called with
the ERC-721-standard binding for this contract and token, the agent
URI recorded at mint — the token's metadata route when no agent base
URI is set (the fallback), and the metadata service's agent route
when one is set, whether at deploy or later through the owner-only
setter (clearing it restores the fallback, and `tokenURI` is
unaffected either way) — registration running on
every mint path (whitelist, reserve, and SeaDrop included), the
identity NFT custodied by the Adapter (never in the token's wallet,
never in the collection contract), a repeat registration reverting
without a second Adapter call, a mint with no Adapter configured
behaving exactly as a plain mint with no registration, and the
`registerAgent` fallback for such a token — refusing to run before
the Adapter is set (owner-only setter, owner-only fallback), the
Adapter rejecting the fallback call until the token's owner grants
the contract the manage delegation, and the fallback then registering
with the token's owner observed at call time;
`withdraw()` moving all proceeds to pixel's wallet; the owner
reserve — a specific ID minted free to pixel's wallet while the mint is
closed (with its ERC-6551 account created), owner-only enforcement, the
16th reserve reverting, the public mint skipping a reserved ID, and
reserve + public mints together never passing 444 (429 public at full
reserve); and the whitelist — the mint starting in the Closed phase with
a default per-wallet cap of 1, a non-whitelisted wallet reverting in the
Whitelist phase, a whitelisted wallet minting at the same price with its
ERC-6551 account created, the per-wallet cap reverting a second
whitelist mint until the owner raises it, a removed wallet losing mint
access, phase / list / cap changes being owner-only, public-phase mints
working for never-whitelisted wallets, and reserve minting working
during the Whitelist phase; and the SeaDrop door — an owner-allowed
caller minting to a recipient with ERC-6551 accounts created while the
custom phase stays Closed, a non-allowed (or allowed-then-removed)
caller reverting, the allowed-list update being owner-only, the price
enforced across the total quantity (underpayment and mismatched
recipient/quantity arrays revert; a multi-recipient mint lands
correctly), reserved IDs skipped with the reserve count untouched, and
the 444 cap holding on the SeaDrop path (an over-supply single call
reverts, a full 444 SeaDrop sellout succeeds, and the next mint
reverts); and the ERC-721T / ERC-8048 store — ERC-165 detection of
`0xdf670be1` (with the ERC-721 and ERC-2981 IDs still reported),
ERC-4906 (`0x49064906`) advertised and `MetadataUpdate` emitted on a
post-mint `setMetadata` write and at registration, a
set/get round trip where the issuer writes `context` and the token
owner writes `endpoint[web]` (with `MetadataSet` emitted and unset
keys reading empty), a stranger's write reverting (including an owner
of a different token writing someone else's records), the Base
address key present with exactly the token's ERC-6551 account bytes
after a direct mint, after a reserve mint, and after a SeaDrop mint,
and the mint writing the agent-registration key naming the
registry (ERC-7930) and the issued agentId with the value `"1"`.

Local-test note: for SeaDrop, a test signer stands in as the allowed
SeaDrop caller (allowlisted via `updateAllowedSeaDrop`); no real
SeaDrop address appears anywhere in the code or the tests. The
ERC-6551 registry address is hardcoded to the
canonical registry (as it will be on Base). The test suite etches a mock
registry's bytecode at that address on the local network
(`contracts/mocks/Mocks.sol`) so the exact production call path runs. The
mock mirrors the real registry's CREATE2 derivation semantics; the real
account implementation is only an input to the derivation in tests.
For ERC-8004, a mock registry and a mock Adapter (also in `Mocks.sol`)
stand in for the real pair: the mock Adapter registers into the mock
registry with itself as the identity's custodian and records its call
arguments and bindings, mirroring the real Adapter's custody model.
It also enforces the real Adapter's caller-authority rule in modeled
form — the token contract is authorized only while the bound token
has no owner, the token's current owner is authorized, and a caller
the owner has delegated is authorized, with the delegate.xyz grant
represented by a test-set mapping — and it records the owner it
observed at each registration, which is how the suite proves the
mint registers before it assigns (see the caller-authority note
above).
