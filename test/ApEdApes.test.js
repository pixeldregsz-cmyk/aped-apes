const { expect } = require("chai");
const { ethers } = require("hardhat");

const PIXEL_WALLET = ethers.getAddress("0x4f9883c7331ba59a56360ffa3c332e0bc09029fc");
const CANONICAL_6551_REGISTRY = "0x000000006551c19487814612e58FE06813775758";
const PRICE = ethers.parseEther("0.002"); // test-only price; the real ETH figure is pixel's deploy call

describe("ApEdApes", function () {
  let apes, mock8004, mockAdapter, owner, buyer, other;

  beforeEach(async function () {
    [owner, buyer, other] = await ethers.getSigners();

    // Etch the mock ERC-6551 registry's code at the canonical registry
    // address so the collection contract's hardcoded registry calls work
    // on the local network exactly as they will on Base.
    const MockReg = await ethers.getContractFactory("Mock6551Registry");
    const mockReg = await MockReg.deploy();
    await mockReg.waitForDeployment();
    const code = await ethers.provider.getCode(await mockReg.getAddress());
    await ethers.provider.send("hardhat_setCode", [CANONICAL_6551_REGISTRY, code]);

    const Mock8004 = await ethers.getContractFactory("Mock8004Registry");
    mock8004 = await Mock8004.deploy();
    await mock8004.waitForDeployment();

    // The Adapter front-end registration runs through: it registers
    // identities in the mock registry with itself as their custodian.
    const MockAdapter = await ethers.getContractFactory("MockAdapter8004");
    mockAdapter = await MockAdapter.deploy(await mock8004.getAddress());
    await mockAdapter.waitForDeployment();

    const ApEd = await ethers.getContractFactory("ApEdApes");
    apes = await ApEd.deploy(
      PRICE,
      1000,
      "ipfs://aped-meta/",
      await mock8004.getAddress(),
      await mockAdapter.getAddress()
    );
    await apes.waitForDeployment();
  });

  it("starts with the mint CLOSED and rejects mints", async function () {
    expect(await apes.mintOpen()).to.equal(false);
    await expect(apes.connect(buyer).mint(1, { value: PRICE })).to.be.revertedWith(
      "ApEd: mint is closed"
    );
  });

  it("only the owner can open the mint", async function () {
    await expect(apes.connect(buyer).setMintOpen(true)).to.be.reverted;
    await apes.setMintOpen(true);
    expect(await apes.mintOpen()).to.equal(true);
  });

  it("mints when open and charges exactly the set price", async function () {
    await apes.setMintOpen(true);
    // wrong payment reverts
    await expect(apes.connect(buyer).mint(1, { value: PRICE - 1n })).to.be.revertedWith(
      "ApEd: wrong payment"
    );
    await expect(apes.connect(buyer).mint(2, { value: PRICE })).to.be.revertedWith(
      "ApEd: wrong payment"
    );
    // exact payment mints sequential IDs starting at 1
    await apes.connect(buyer).mint(2, { value: PRICE * 2n });
    expect(await apes.ownerOf(1)).to.equal(buyer.address);
    expect(await apes.ownerOf(2)).to.equal(buyer.address);
    expect(await apes.totalMinted()).to.equal(2);
    expect(await ethers.provider.getBalance(await apes.getAddress())).to.equal(PRICE * 2n);
  });

  it("owner can change the mint price and the new price is charged", async function () {
    await apes.setMintOpen(true);
    const newPrice = ethers.parseEther("0.005");
    await apes.setMintPrice(newPrice);
    await expect(apes.connect(buyer).mint(1, { value: PRICE })).to.be.revertedWith(
      "ApEd: wrong payment"
    );
    await apes.connect(buyer).mint(1, { value: newPrice });
    expect(await apes.ownerOf(1)).to.equal(buyer.address);
  });

  it("enforces the 444 supply cap", async function () {
    await apes.setMintPrice(1n); // 1 wei, test only
    await apes.setMintOpen(true);
    let minted = 0;
    while (minted < 444) {
      const qty = Math.min(60, 444 - minted);
      await apes.connect(buyer).mint(qty, { value: BigInt(qty) });
      minted += qty;
    }
    expect(await apes.totalMinted()).to.equal(444);
    expect(await apes.ownerOf(444)).to.equal(buyer.address);
    await expect(apes.connect(buyer).mint(1, { value: 1n })).to.be.revertedWith(
      "ApEd: supply cap reached"
    );
  });

  it("creates the ERC-6551 token-bound account at mint, at the derived address", async function () {
    await apes.setMintOpen(true);
    await apes.connect(buyer).mint(1, { value: PRICE });
    const tba = await apes.tokenAccount(1);
    expect(tba).to.not.equal(ethers.ZeroAddress);
    // code exists at the derived address: the account was actually deployed
    expect(await ethers.provider.getCode(tba)).to.not.equal("0x");
    // derivation matches the registry's own view for the same parameters
    const registry = await ethers.getContractAt("Mock6551Registry", CANONICAL_6551_REGISTRY);
    const derived = await registry.account(
      await apes.ERC6551_IMPLEMENTATION(),
      (await ethers.provider.getNetwork()).chainId,
      await apes.getAddress(),
      1,
      0
    );
    expect(tba).to.equal(derived);
    // the permissionless helper is idempotent for an existing account
    await apes.connect(other).ensureTokenAccount(1);
    expect(await apes.tokenAccount(1)).to.equal(tba);
  });

  it("serves tokenURI from the owner-set base URI", async function () {
    await apes.setMintOpen(true);
    await apes.connect(buyer).mint(1, { value: PRICE });
    expect(await apes.tokenURI(1)).to.equal("ipfs://aped-meta/1");
    await apes.setBaseURI("https://meta.example/aped/");
    expect(await apes.tokenURI(1)).to.equal("https://meta.example/aped/1");
  });

  it("returns pixel's wallet from royaltyInfo at the configured rate", async function () {
    const [receiver, amount] = await apes.royaltyInfo(1, 10000);
    expect(receiver).to.equal(PIXEL_WALLET);
    expect(amount).to.equal(1000); // 1000 bps = 10% of 10,000 (test placeholder rate)
  });

  it("registers an ERC-8004 agent for a minted token and records the agentId", async function () {
    await apes.setMintOpen(true);
    await apes.connect(buyer).mint(1, { value: PRICE });
    await expect(apes.connect(buyer).registerAgent(1, "ipfs://agent/1")).to.be.reverted; // owner only
    await apes.registerAgent(1, "ipfs://agent/1");
    expect(await apes.agentIdOf(1)).to.equal(1);
    // a second registration for the same token reverts cleanly: the
    // recorded agentId stands and the Adapter is not called again
    await expect(apes.registerAgent(1, "ipfs://agent/1")).to.be.revertedWith(
      "ApEd: agent already registered"
    );
    expect(await apes.agentIdOf(1)).to.equal(1);
    expect(await mockAdapter.registerCalls()).to.equal(1);
  });

  it("registerAgent binds the token through the Adapter under the ERC-721 standard", async function () {
    await apes.setMintOpen(true);
    await apes.connect(buyer).mint(1, { value: PRICE });
    await apes.registerAgent(1, "ipfs://agent/1");
    // the Adapter was called once, with the binding the design calls
    // for: standard 0 (ERC721 — control follows ownerOf), this
    // contract as the bound address, the token ID, and the agent URI
    expect(await mockAdapter.registerCalls()).to.equal(1);
    expect(await mockAdapter.lastStandard()).to.equal(0);
    expect(await mockAdapter.lastBoundAddress()).to.equal(await apes.getAddress());
    expect(await mockAdapter.lastTokenId()).to.equal(1);
    expect(await mockAdapter.lastAgentURI()).to.equal("ipfs://agent/1");
    // and the stored binding for the issued agentId matches
    const binding = await mockAdapter.bindingOf(await apes.agentIdOf(1));
    expect(binding.standard).to.equal(0);
    expect(binding.boundAddress).to.equal(await apes.getAddress());
    expect(binding.tokenId).to.equal(1);
  });

  it("the Adapter custodies the ERC-8004 identity — not the ape's wallet, not the contract", async function () {
    await apes.setMintOpen(true);
    await apes.connect(buyer).mint(1, { value: PRICE });
    await apes.registerAgent(1, "ipfs://agent/1");
    const agentId = await apes.agentIdOf(1);
    const tba = await apes.tokenAccount(1);
    // the identity NFT is owned by the Adapter, which custodies it
    // bound to the token — it can never be stripped out of the ape
    expect(await mock8004.ownerOf(agentId)).to.equal(await mockAdapter.getAddress());
    // it does NOT sit in the token's ERC-6551 wallet...
    expect(await mock8004.balanceOf(tba)).to.equal(0);
    // ...and it never rests in the collection contract either
    expect(await mock8004.balanceOf(await apes.getAddress())).to.equal(0);
  });

  it("registerAgent reverts until the Adapter is set, and only the owner can set it", async function () {
    // a second deployment with no Adapter configured
    const ApEd = await ethers.getContractFactory("ApEdApes");
    const bare = await ApEd.deploy(
      PRICE,
      1000,
      "ipfs://aped-meta/",
      await mock8004.getAddress(),
      ethers.ZeroAddress
    );
    await bare.waitForDeployment();
    await bare.setMintOpen(true);
    await bare.connect(buyer).mint(1, { value: PRICE });
    await expect(bare.registerAgent(1, "ipfs://agent/1")).to.be.revertedWith(
      "ApEd: agent adapter not set"
    );
    // only the owner can set the Adapter
    await expect(bare.connect(buyer).setAgentAdapter(await mockAdapter.getAddress())).to.be
      .reverted;
    await bare.setAgentAdapter(await mockAdapter.getAddress());
    expect(await bare.agentAdapter()).to.equal(await mockAdapter.getAddress());
    // with it set, registration runs through the Adapter as usual
    await bare.registerAgent(1, "ipfs://agent/1");
    expect(await bare.agentIdOf(1)).to.equal(1);
  });

  it("withdraw sends all mint proceeds to pixel's wallet", async function () {
    await apes.setMintOpen(true);
    await apes.connect(buyer).mint(3, { value: PRICE * 3n });
    const before = await ethers.provider.getBalance(PIXEL_WALLET);
    await expect(apes.connect(buyer).withdraw()).to.be.reverted; // owner only
    await apes.withdraw();
    const after = await ethers.provider.getBalance(PIXEL_WALLET);
    expect(after - before).to.equal(PRICE * 3n);
    expect(await ethers.provider.getBalance(await apes.getAddress())).to.equal(0);
  });

  it("reserve-mints a specific ID to pixel's wallet, free, while the mint is closed", async function () {
    // the public mint stays CLOSED the whole time: the reserve does not need it open
    expect(await apes.mintOpen()).to.equal(false);
    await apes.reserveMint(200);
    expect(await apes.ownerOf(200)).to.equal(PIXEL_WALLET);
    expect(await apes.isReserved(200)).to.equal(true);
    expect(await apes.reserveMinted()).to.equal(1);
    expect(await apes.totalMinted()).to.equal(1);
    // no charge: the contract holds nothing
    expect(await ethers.provider.getBalance(await apes.getAddress())).to.equal(0);
    // the reserve ape gets its ERC-6551 account, same as a public mint
    const tba = await apes.tokenAccount(200);
    expect(tba).to.not.equal(ethers.ZeroAddress);
    expect(await ethers.provider.getCode(tba)).to.not.equal("0x");
    // an out-of-range ID reverts
    await expect(apes.reserveMint(445)).to.be.revertedWith("ApEd: invalid token id");
  });

  it("reserve mint is owner-only", async function () {
    await expect(apes.connect(buyer).reserveMint(7)).to.be.reverted;
    expect(await apes.totalMinted()).to.equal(0);
    expect(await apes.reserveMinted()).to.equal(0);
  });

  it("reverts on the 16th reserve mint", async function () {
    for (let id = 1; id <= 15; id++) {
      await apes.reserveMint(id);
    }
    expect(await apes.reserveMinted()).to.equal(15);
    expect(await apes.totalMinted()).to.equal(15);
    await expect(apes.reserveMint(16)).to.be.revertedWith("ApEd: reserve exhausted");
  });

  it("public mint skips a reserved ID and hands out the next one", async function () {
    await apes.reserveMint(1);
    await apes.setMintOpen(true);
    await apes.connect(buyer).mint(2, { value: PRICE * 2n });
    expect(await apes.ownerOf(1)).to.equal(PIXEL_WALLET);
    expect(await apes.ownerOf(2)).to.equal(buyer.address);
    expect(await apes.ownerOf(3)).to.equal(buyer.address);
    expect(await apes.totalMinted()).to.equal(3);
  });

  it("reserve + public mints together can never pass 444", async function () {
    await apes.setMintPrice(1n); // 1 wei, test only
    for (let id = 1; id <= 15; id++) {
      await apes.reserveMint(id);
    }
    await apes.setMintOpen(true);
    // only 429 public mints remain; asking for 430 reverts up front
    await expect(apes.connect(buyer).mint(430, { value: 430n })).to.be.revertedWith(
      "ApEd: supply cap reached"
    );
    let minted = 0;
    while (minted < 429) {
      const qty = Math.min(60, 429 - minted);
      await apes.connect(buyer).mint(qty, { value: BigInt(qty) });
      minted += qty;
    }
    expect(await apes.totalMinted()).to.equal(444);
    expect(await apes.ownerOf(444)).to.equal(buyer.address);
    // neither path can mint a 445th
    await expect(apes.connect(buyer).mint(1, { value: 1n })).to.be.revertedWith(
      "ApEd: supply cap reached"
    );
    await expect(apes.reserveMint(100)).to.be.revertedWith("ApEd: reserve exhausted");
  });

  it("starts in the Closed phase with the whitelist defaults in place", async function () {
    expect(await apes.mintPhase()).to.equal(0); // Closed
    expect(await apes.mintOpen()).to.equal(false);
    expect(await apes.wlPerWallet()).to.equal(1);
    expect(await apes.isWhitelisted(buyer.address)).to.equal(false);
  });

  it("rejects a non-whitelisted wallet in the Whitelist phase", async function () {
    await apes.setMintPhase(1); // Whitelist
    await expect(apes.connect(buyer).mint(1, { value: PRICE })).to.be.revertedWith(
      "ApEd: not whitelisted"
    );
    expect(await apes.totalMinted()).to.equal(0);
  });

  it("lets a whitelisted wallet mint in the Whitelist phase at the mint price", async function () {
    await apes.addToWhitelist([buyer.address, other.address]); // batch add
    expect(await apes.isWhitelisted(buyer.address)).to.equal(true);
    expect(await apes.isWhitelisted(other.address)).to.equal(true);
    await apes.setMintPhase(1); // Whitelist
    // same price as the public phase: underpaying reverts
    await expect(apes.connect(buyer).mint(1, { value: PRICE - 1n })).to.be.revertedWith(
      "ApEd: wrong payment"
    );
    await apes.connect(buyer).mint(1, { value: PRICE });
    expect(await apes.ownerOf(1)).to.equal(buyer.address);
    expect(await apes.wlMinted(buyer.address)).to.equal(1);
    // the whitelist ape gets its ERC-6551 account, same as a public mint
    expect(await ethers.provider.getCode(await apes.tokenAccount(1))).to.not.equal("0x");
  });

  it("enforces the per-wallet whitelist cap until the owner raises it", async function () {
    await apes.addToWhitelist([buyer.address]);
    await apes.setMintPhase(1); // Whitelist, default cap 1
    await apes.connect(buyer).mint(1, { value: PRICE });
    await expect(apes.connect(buyer).mint(1, { value: PRICE })).to.be.revertedWith(
      "ApEd: whitelist cap reached"
    );
    await apes.setWlPerWallet(2);
    await apes.connect(buyer).mint(1, { value: PRICE });
    expect(await apes.wlMinted(buyer.address)).to.equal(2);
    expect(await apes.ownerOf(2)).to.equal(buyer.address);
  });

  it("a removed wallet can no longer mint in the Whitelist phase", async function () {
    await apes.addToWhitelist([buyer.address]);
    expect(await apes.isWhitelisted(buyer.address)).to.equal(true);
    await apes.removeFromWhitelist([buyer.address]);
    expect(await apes.isWhitelisted(buyer.address)).to.equal(false);
    await apes.setMintPhase(1); // Whitelist
    await expect(apes.connect(buyer).mint(1, { value: PRICE })).to.be.revertedWith(
      "ApEd: not whitelisted"
    );
  });

  it("only the owner can change the phase, the list, or the cap", async function () {
    await expect(apes.connect(buyer).setMintPhase(2)).to.be.reverted;
    await expect(apes.connect(buyer).addToWhitelist([buyer.address])).to.be.reverted;
    await expect(apes.connect(buyer).removeFromWhitelist([buyer.address])).to.be.reverted;
    await expect(apes.connect(buyer).setWlPerWallet(5)).to.be.reverted;
    expect(await apes.mintPhase()).to.equal(0);
    expect(await apes.isWhitelisted(buyer.address)).to.equal(false);
    expect(await apes.wlPerWallet()).to.equal(1);
  });

  it("public phase mints work for wallets that were never whitelisted", async function () {
    await apes.setMintPhase(2); // Public
    expect(await apes.isWhitelisted(other.address)).to.equal(false);
    await apes.connect(other).mint(1, { value: PRICE });
    expect(await apes.ownerOf(1)).to.equal(other.address);
    // public mints do not consume whitelist allowance
    expect(await apes.wlMinted(other.address)).to.equal(0);
  });

  it("reserve minting works during the Whitelist phase", async function () {
    await apes.setMintPhase(1); // Whitelist
    await apes.reserveMint(300);
    expect(await apes.ownerOf(300)).to.equal(PIXEL_WALLET);
    expect(await apes.totalMinted()).to.equal(1);
  });

  // ---------------------------------------------------------------
  // SeaDrop (OpenSea). The `other` signer stands in for the SeaDrop
  // contract: an address the owner has allowed via
  // updateAllowedSeaDrop. No real SeaDrop address is used anywhere.
  // ---------------------------------------------------------------

  it("SeaDrop: mints to the recipient with a token account, while the custom phase is Closed", async function () {
    // the custom phase system stays Closed the whole time — SeaDrop has
    // its own gating and must not be blocked by it
    expect(await apes.mintPhase()).to.equal(0); // Closed
    await apes.updateAllowedSeaDrop([other.address], true);
    expect(await apes.isAllowedSeaDrop(other.address)).to.equal(true);
    expect(await apes.getAllowedSeaDrop()).to.deep.equal([other.address]);

    await apes
      .connect(other)
      .mintSeaDrop(buyer.address, owner.address, [buyer.address], [2], { value: PRICE * 2n });
    expect(await apes.ownerOf(1)).to.equal(buyer.address);
    expect(await apes.ownerOf(2)).to.equal(buyer.address);
    expect(await apes.totalMinted()).to.equal(2);
    // each token's ERC-6551 account was created, same as a direct mint
    expect(await ethers.provider.getCode(await apes.tokenAccount(1))).to.not.equal("0x");
    expect(await ethers.provider.getCode(await apes.tokenAccount(2))).to.not.equal("0x");
    // proceeds sit in the contract, withdrawable to pixel as usual
    expect(await ethers.provider.getBalance(await apes.getAddress())).to.equal(PRICE * 2n);
  });

  it("SeaDrop: reverts from a caller that is not an allowed SeaDrop", async function () {
    await expect(
      apes
        .connect(buyer)
        .mintSeaDrop(buyer.address, owner.address, [buyer.address], [1], { value: PRICE })
    ).to.be.revertedWith("ApEd: caller is not an allowed SeaDrop");
    // an address allowed and then removed is rejected again
    await apes.updateAllowedSeaDrop([other.address], true);
    await apes.updateAllowedSeaDrop([other.address], false);
    expect(await apes.isAllowedSeaDrop(other.address)).to.equal(false);
    expect(await apes.getAllowedSeaDrop()).to.deep.equal([]);
    await expect(
      apes
        .connect(other)
        .mintSeaDrop(buyer.address, owner.address, [buyer.address], [1], { value: PRICE })
    ).to.be.revertedWith("ApEd: caller is not an allowed SeaDrop");
    expect(await apes.totalMinted()).to.equal(0);
  });

  it("SeaDrop: only the owner can update the allowed SeaDrop list", async function () {
    await expect(apes.connect(buyer).updateAllowedSeaDrop([other.address], true)).to.be.reverted;
    expect(await apes.isAllowedSeaDrop(other.address)).to.equal(false);
    expect(await apes.getAllowedSeaDrop()).to.deep.equal([]);
  });

  it("SeaDrop: enforces the mint price across the total quantity", async function () {
    await apes.updateAllowedSeaDrop([other.address], true);
    // underpaying for the total quantity reverts
    await expect(
      apes
        .connect(other)
        .mintSeaDrop(buyer.address, owner.address, [buyer.address], [2], { value: PRICE * 2n - 1n })
    ).to.be.revertedWith("ApEd: wrong payment");
    // mismatched recipient/quantity arrays revert
    await expect(
      apes
        .connect(other)
        .mintSeaDrop(buyer.address, owner.address, [buyer.address], [1, 1], { value: PRICE * 2n })
    ).to.be.revertedWith("ApEd: SeaDrop array length mismatch");
    // exact cover across multiple recipients mints to each of them
    await apes
      .connect(other)
      .mintSeaDrop(buyer.address, owner.address, [buyer.address, other.address], [1, 2], {
        value: PRICE * 3n,
      });
    expect(await apes.ownerOf(1)).to.equal(buyer.address);
    expect(await apes.ownerOf(2)).to.equal(other.address);
    expect(await apes.ownerOf(3)).to.equal(other.address);
    expect(await apes.totalMinted()).to.equal(3);
  });

  it("SeaDrop: skips reserved IDs and cannot reach the reserve path", async function () {
    await apes.reserveMint(1);
    await apes.reserveMint(2);
    await apes.updateAllowedSeaDrop([other.address], true);
    await apes
      .connect(other)
      .mintSeaDrop(buyer.address, owner.address, [buyer.address], [2], { value: PRICE * 2n });
    // the SeaDrop mint handed out the lowest UNRESERVED IDs
    expect(await apes.ownerOf(1)).to.equal(PIXEL_WALLET);
    expect(await apes.ownerOf(2)).to.equal(PIXEL_WALLET);
    expect(await apes.ownerOf(3)).to.equal(buyer.address);
    expect(await apes.ownerOf(4)).to.equal(buyer.address);
    expect(await apes.reserveMinted()).to.equal(2); // unchanged by the SeaDrop mint
    expect(await apes.totalMinted()).to.equal(4);
  });

  it("SeaDrop: respects the 444 cap across all mint paths", async function () {
    await apes.setMintPrice(1n); // 1 wei, test only
    await apes.updateAllowedSeaDrop([other.address], true);
    // asking for more than the whole supply reverts up front
    await expect(
      apes
        .connect(other)
        .mintSeaDrop(buyer.address, owner.address, [buyer.address], [445], { value: 445n })
    ).to.be.revertedWith("ApEd: supply cap reached");
    let minted = 0;
    while (minted < 444) {
      const qty = Math.min(60, 444 - minted);
      await apes
        .connect(other)
        .mintSeaDrop(buyer.address, owner.address, [buyer.address], [qty], { value: BigInt(qty) });
      minted += qty;
    }
    expect(await apes.totalMinted()).to.equal(444);
    expect(await apes.ownerOf(444)).to.equal(buyer.address);
    await expect(
      apes
        .connect(other)
        .mintSeaDrop(buyer.address, owner.address, [buyer.address], [1], { value: 1n })
    ).to.be.revertedWith("ApEd: supply cap reached");
  });

  // ---------------------------------------------------------------
  // ERC-8048 onchain metadata / ERC-721T agent profile.
  // ---------------------------------------------------------------

  // The ERC-721T Base address key: the exact string EIP-8048 gives for
  // Base (chain ID 8453, ERC-7930 Chain Identifier 0x0001000002210500).
  const BASE_ADDRESS_KEY = "address[0x0001000002210500]";

  // ERC-7930 interoperable address of an account on the given chain:
  // 0x0001 (version) | 0000 (EIP-155) | chain ID in minimal big-endian
  // bytes | 0x14 (20-byte address length) | the address, hex-encoded
  // lowercase with a 0x prefix — the registry naming ENSIP-25 defines
  // for the agent-registration key.
  function erc7930Address(chainId, account) {
    let chainHex = chainId.toString(16);
    if (chainHex.length % 2) chainHex = "0" + chainHex;
    return "0x0001" + "0000" + chainHex + "14" + account.slice(2).toLowerCase();
  }

  it("721T: advertises ERC-8048 through ERC-165", async function () {
    expect(await apes.supportsInterface("0xdf670be1")).to.equal(true); // ERC-8048
    // the pre-existing surfaces are still advertised
    expect(await apes.supportsInterface("0x80ac58cd")).to.equal(true); // ERC-721
    expect(await apes.supportsInterface("0x2a55205a")).to.equal(true); // ERC-2981
  });

  it("721T: emits ERC-4906 MetadataUpdate when a stored value changes", async function () {
    // ERC-165 advertises ERC-4906 alongside the other surfaces
    expect(await apes.supportsInterface("0x49064906")).to.equal(true);
    await apes.setMintOpen(true);
    await apes.connect(buyer).mint(1, { value: PRICE });
    // a post-mint setMetadata write signals the refresh, so OpenSea
    // re-reads the token instead of serving its cached copy
    await expect(apes.setMetadata(1, "context", ethers.toUtf8Bytes("# ApEd #1")))
      .to.emit(apes, "MetadataUpdate")
      .withArgs(1);
    // the signal rides the same internal write path as every write:
    // registration emits it too
    await expect(apes.registerAgent(1, "ipfs://agent/1"))
      .to.emit(apes, "MetadataUpdate")
      .withArgs(1);
  });

  it("721T: set/get round trip — the issuer and the token owner can both write", async function () {
    await apes.setMintOpen(true);
    await apes.connect(buyer).mint(1, { value: PRICE });
    // the contract owner (issuer) writes the context record
    const context = ethers.toUtf8Bytes("# ApEd #1\nThe first ape.");
    await apes.setMetadata(1, "context", context);
    expect(await apes.metadata(1, "context")).to.equal(ethers.hexlify(context));
    // the token's owner writes an endpoint record for their own token
    const endpoint = ethers.toUtf8Bytes("https://aped.example/apes/1");
    await expect(apes.connect(buyer).setMetadata(1, "endpoint[web]", endpoint))
      .to.emit(apes, "MetadataSet")
      .withArgs(1, "endpoint[web]", "endpoint[web]", ethers.hexlify(endpoint));
    expect(await apes.metadata(1, "endpoint[web]")).to.equal(ethers.hexlify(endpoint));
    // an unset key reads back empty
    expect(await apes.metadata(1, "endpoint[mcp]")).to.equal("0x");
  });

  it("721T: a stranger cannot write a token's records", async function () {
    await apes.setMintOpen(true);
    await apes.connect(buyer).mint(1, { value: PRICE });
    // `other` neither owns the contract nor token 1
    await expect(
      apes.connect(other).setMetadata(1, "context", ethers.toUtf8Bytes("hijacked"))
    ).to.be.revertedWith("ApEd: not a metadata writer for this token");
    // owning a DIFFERENT token does not help either: other owns token 2,
    // and still cannot write token 1's records (nor buyer token 2's)
    await apes.connect(other).mint(1, { value: PRICE });
    await expect(
      apes.connect(other).setMetadata(1, "context", ethers.toUtf8Bytes("still not mine"))
    ).to.be.revertedWith("ApEd: not a metadata writer for this token");
    await expect(
      apes.connect(buyer).setMetadata(2, "context", ethers.toUtf8Bytes("not mine"))
    ).to.be.revertedWith("ApEd: not a metadata writer for this token");
    expect(await apes.metadata(1, "context")).to.equal("0x");
    expect(await apes.metadata(2, "context")).to.equal("0x");
  });

  it("721T: writes the token's ERC-6551 account under the Base address key at direct mint", async function () {
    await apes.setMintOpen(true);
    const tx = await apes.connect(buyer).mint(1, { value: PRICE });
    const tba = await apes.tokenAccount(1);
    await expect(tx)
      .to.emit(apes, "MetadataSet")
      .withArgs(1, BASE_ADDRESS_KEY, BASE_ADDRESS_KEY, tba.toLowerCase());
    const stored = await apes.metadata(1, BASE_ADDRESS_KEY);
    // exactly the account's 20 address bytes (metadata() hex is lowercase,
    // tokenAccount() returns the checksummed form — same bytes)
    expect(stored.toLowerCase()).to.equal(tba.toLowerCase());
    expect(ethers.getBytes(stored).length).to.equal(20);
  });

  it("721T: writes the Base address key on the reserve and SeaDrop paths too", async function () {
    // reserve path (public mint closed, owner-only)
    await apes.reserveMint(200);
    expect((await apes.metadata(200, BASE_ADDRESS_KEY)).toLowerCase()).to.equal(
      (await apes.tokenAccount(200)).toLowerCase()
    );
    // SeaDrop path
    await apes.updateAllowedSeaDrop([other.address], true);
    await apes
      .connect(other)
      .mintSeaDrop(buyer.address, owner.address, [buyer.address], [1], { value: PRICE });
    expect(await apes.ownerOf(1)).to.equal(buyer.address);
    expect((await apes.metadata(1, BASE_ADDRESS_KEY)).toLowerCase()).to.equal(
      (await apes.tokenAccount(1)).toLowerCase()
    );
  });

  it("721T: registerAgent writes the agent-registration key naming the registry and agentId", async function () {
    await apes.setMintOpen(true);
    await apes.connect(buyer).mint(1, { value: PRICE });
    const registry = await mock8004.getAddress();
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const key = `agent-registration[${erc7930Address(chainId, registry)}][1]`;
    // nothing recorded before registration
    expect(await apes.metadata(1, key)).to.equal("0x");
    await apes.registerAgent(1, "ipfs://agent/1");
    expect(await apes.agentIdOf(1)).to.equal(1);
    // ENSIP-25 semantics: the value is the attestation marker "1"; the
    // key itself names the registry (ERC-7930) and the issued agentId
    expect(await apes.metadata(1, key)).to.equal(ethers.hexlify(ethers.toUtf8Bytes("1")));
  });
});
