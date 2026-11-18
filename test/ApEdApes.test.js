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
      await mockAdapter.getAddress(),
      "" // no agent base URI: the recorded agentURI falls back to the metadata route
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
      const qty = Math.min(25, 444 - minted);
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

  it("registers the agent inside the mint — before the buyer owns the token", async function () {
    await apes.setMintOpen(true);
    await apes.connect(buyer).mint(1, { value: PRICE });
    // the identity exists the moment the mint lands: no separate step
    expect(await apes.agentIdOf(1)).to.equal(1);
    expect(await mockAdapter.registerCalls()).to.equal(1);
    // ORDER PROOF: the mock Adapter enforces the real Adapter's
    // caller-authority rule and records the owner it observed at call
    // time — at registration the token had NO owner (Prem's order:
    // register, then assign to the buyer)
    expect(await mockAdapter.sawNoOwnerForToken(1)).to.equal(true);
    expect(await mockAdapter.ownerSeenForToken(1)).to.equal(ethers.ZeroAddress);
    expect(await mockAdapter.lastHadOwnerAtCall()).to.equal(false);
    // ...and only afterwards did the buyer come to own the token
    expect(await apes.ownerOf(1)).to.equal(buyer.address);
    // a second registration for the same token reverts cleanly: the
    // recorded agentId stands and the Adapter is not called again
    await expect(apes.registerAgent(1, "ipfs://aped-meta/1")).to.be.revertedWith(
      "ApEd: agent already registered"
    );
    expect(await apes.agentIdOf(1)).to.equal(1);
    expect(await mockAdapter.registerCalls()).to.equal(1);
  });

  it("registers a multi-mint in token order, every one pre-assignment", async function () {
    await apes.setMintOpen(true);
    await apes.connect(buyer).mint(3, { value: PRICE * 3n });
    expect(await mockAdapter.registerCalls()).to.equal(3);
    expect(await mockAdapter.registerOrderLength()).to.equal(3);
    expect(await mockAdapter.registerOrder(0)).to.equal(1);
    expect(await mockAdapter.registerOrder(1)).to.equal(2);
    expect(await mockAdapter.registerOrder(2)).to.equal(3);
    for (const id of [1, 2, 3]) {
      expect(await mockAdapter.sawNoOwnerForToken(id)).to.equal(true);
      expect(await apes.agentIdOf(id)).to.equal(id);
      expect(await apes.ownerOf(id)).to.equal(buyer.address);
    }
  });

  it("mint binds the token through the Adapter under the ERC-721 standard, agent URI = the token's metadata route", async function () {
    await apes.setMintOpen(true);
    await apes.connect(buyer).mint(1, { value: PRICE });
    // the Adapter was called once, with the binding the design calls
    // for: standard 0 (ERC721 — control follows ownerOf), this
    // contract as the bound address, the token ID, and the agent URI —
    // which at mint is the token's own metadata route (its tokenURI)
    expect(await mockAdapter.registerCalls()).to.equal(1);
    expect(await mockAdapter.lastStandard()).to.equal(0);
    expect(await mockAdapter.lastBoundAddress()).to.equal(await apes.getAddress());
    expect(await mockAdapter.lastTokenId()).to.equal(1);
    expect(await mockAdapter.lastAgentURI()).to.equal("ipfs://aped-meta/1");
    expect(await mockAdapter.lastAgentURI()).to.equal(await apes.tokenURI(1));
    // and the stored binding for the issued agentId matches
    const binding = await mockAdapter.bindingOf(await apes.agentIdOf(1));
    expect(binding.standard).to.equal(0);
    expect(binding.boundAddress).to.equal(await apes.getAddress());
    expect(binding.tokenId).to.equal(1);
  });

  it("records the agent-route URI at mint when an agent base URI is set at deploy", async function () {
    // a deployment whose agent base URI names the metadata service's
    // dedicated agent route: the recorded agentURI points there — a
    // link the project controls, serving the token's ERC-8004 agent
    // file (Prem's suggestion, 2026-11-17) — NOT at the tokenURI route
    const ApEd = await ethers.getContractFactory("ApEdApes");
    const routed = await ApEd.deploy(
      PRICE,
      1000,
      "https://meta.example/metadata/",
      await mock8004.getAddress(),
      await mockAdapter.getAddress(),
      "https://meta.example/agent/"
    );
    await routed.waitForDeployment();
    expect(await routed.agentBaseURI()).to.equal("https://meta.example/agent/");
    await routed.setMintOpen(true);
    await routed.connect(buyer).mint(1, { value: PRICE });
    expect(await mockAdapter.lastAgentURI()).to.equal("https://meta.example/agent/1");
    // the tokenURI still serves the metadata route — the two diverge
    expect(await routed.tokenURI(1)).to.equal("https://meta.example/metadata/1");
    expect(await mockAdapter.lastAgentURI()).to.not.equal(await routed.tokenURI(1));
    expect(await routed.agentIdOf(1)).to.equal(1);
  });

  it("agent base URI is owner-settable after deploy; clearing it restores the metadata-route fallback", async function () {
    // this deployment (beforeEach) has no agent base URI set
    expect(await apes.agentBaseURI()).to.equal("");
    await apes.setMintOpen(true);
    await apes.connect(buyer).mint(1, { value: PRICE });
    // fallback branch: the recorded agentURI is the metadata route
    expect(await mockAdapter.lastAgentURI()).to.equal("ipfs://aped-meta/1");
    expect(await mockAdapter.lastAgentURI()).to.equal(await apes.tokenURI(1));
    // only the owner can set the agent base URI
    await expect(apes.connect(buyer).setAgentBaseURI("https://meta.example/agent/")).to.be
      .reverted;
    await expect(apes.setAgentBaseURI("https://meta.example/agent/"))
      .to.emit(apes, "AgentBaseURISet")
      .withArgs("https://meta.example/agent/");
    expect(await apes.agentBaseURI()).to.equal("https://meta.example/agent/");
    // the next mint records the agent route
    await apes.connect(buyer).mint(1, { value: PRICE });
    expect(await mockAdapter.lastAgentURI()).to.equal("https://meta.example/agent/2");
    // clearing it restores the fallback for later mints
    await apes.setAgentBaseURI("");
    await apes.connect(buyer).mint(1, { value: PRICE });
    expect(await mockAdapter.lastAgentURI()).to.equal("ipfs://aped-meta/3");
  });

  it("the Adapter custodies the ERC-8004 identity — not the ape's wallet, not the contract", async function () {
    await apes.setMintOpen(true);
    await apes.connect(buyer).mint(1, { value: PRICE });
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

  it("registers on every mint path — whitelist, reserve, and SeaDrop included", async function () {
    // Whitelist-phase direct mint
    await apes.addToWhitelist([buyer.address]);
    await apes.setMintPhase(1); // Whitelist
    await apes.connect(buyer).mint(1, { value: PRICE });
    expect(await apes.agentIdOf(1)).to.equal(1);
    expect(await mockAdapter.sawNoOwnerForToken(1)).to.equal(true);
    // reserve mint (owner-only path, any phase)
    await apes.reserveMint(200);
    expect(await apes.agentIdOf(200)).to.not.equal(0);
    expect(await mockAdapter.sawNoOwnerForToken(200)).to.equal(true);
    expect(await apes.ownerOf(200)).to.equal(PIXEL_WALLET);
    // SeaDrop mint
    await apes.updateAllowedSeaDrop([other.address], true);
    await apes
      .connect(other)
      .mintSeaDrop(buyer.address, owner.address, [buyer.address], [1], { value: PRICE });
    expect(await apes.ownerOf(2)).to.equal(buyer.address);
    expect(await apes.agentIdOf(2)).to.not.equal(0);
    expect(await mockAdapter.sawNoOwnerForToken(2)).to.equal(true);
    expect(await mockAdapter.registerCalls()).to.equal(3);
  });

  it("mints exactly as before with no Adapter configured — and the registerAgent fallback covers it later", async function () {
    // a second deployment with no Adapter configured
    const ApEd = await ethers.getContractFactory("ApEdApes");
    const bare = await ApEd.deploy(
      PRICE,
      1000,
      "ipfs://aped-meta/",
      await mock8004.getAddress(),
      ethers.ZeroAddress,
      ""
    );
    await bare.waitForDeployment();
    const bareAddr = await bare.getAddress();
    await bare.setMintOpen(true);
    // the mint succeeds exactly as a plain mint: token, account, URI —
    // and no registration (deploy configuration order must not brick it)
    await bare.connect(buyer).mint(1, { value: PRICE });
    expect(await bare.ownerOf(1)).to.equal(buyer.address);
    expect(await ethers.provider.getCode(await bare.tokenAccount(1))).to.not.equal("0x");
    expect(await bare.tokenURI(1)).to.equal("ipfs://aped-meta/1");
    expect(await bare.agentIdOf(1)).to.equal(0);
    // the fallback refuses to run while no Adapter is set
    await expect(bare.registerAgent(1, "ipfs://aped-meta/1")).to.be.revertedWith(
      "ApEd: agent adapter not set"
    );
    // only the owner can set the Adapter, and registerAgent is owner-only
    await expect(bare.connect(buyer).setAgentAdapter(await mockAdapter.getAddress())).to.be
      .reverted;
    await bare.setAgentAdapter(await mockAdapter.getAddress());
    expect(await bare.agentAdapter()).to.equal(await mockAdapter.getAddress());
    await expect(bare.connect(buyer).registerAgent(1, "ipfs://aped-meta/1")).to.be.reverted;
    // FALLBACK AUTHORITY: post-mint, the Adapter authorizes only the
    // token's owner or their delegate — the contract's call is rejected
    // until the owner grants it the adapter8004.manage delegation
    // (the mock's setManageDelegated stands in for delegate.xyz)
    await expect(bare.registerAgent(1, "ipfs://aped-meta/1")).to.be.revertedWith(
      "MockAdapter: caller not authorized"
    );
    expect(await bare.agentIdOf(1)).to.equal(0);
    await mockAdapter.setManageDelegated(bareAddr, bareAddr, true);
    await bare.registerAgent(1, "ipfs://aped-meta/1");
    expect(await bare.agentIdOf(1)).to.equal(1);
    // the fallback registration observed the token WITH its owner —
    // the exact opposite of the mint-time order, which is the point
    expect(await mockAdapter.sawNoOwnerForToken(1)).to.equal(false);
    expect(await mockAdapter.ownerSeenForToken(1)).to.equal(buyer.address);
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
      const qty = Math.min(25, 429 - minted);
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
      const qty = Math.min(25, 444 - minted);
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
    // the signal rides the same internal write path as every write:
    // the mint itself emits it (registration + address records)
    await expect(apes.connect(buyer).mint(1, { value: PRICE }))
      .to.emit(apes, "MetadataUpdate")
      .withArgs(1);
    // a post-mint setMetadata write signals the refresh, so OpenSea
    // re-reads the token instead of serving its cached copy
    await expect(apes.setMetadata(1, "context", ethers.toUtf8Bytes("# ApEd #1")))
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

  it("721T: the mint writes the agent-registration key naming the registry and agentId", async function () {
    const registry = await mock8004.getAddress();
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const key = `agent-registration[${erc7930Address(chainId, registry)}][1]`;
    // nothing recorded before the mint
    expect(await apes.metadata(1, key)).to.equal("0x");
    await apes.setMintOpen(true);
    await apes.connect(buyer).mint(1, { value: PRICE });
    // registration rode inside the mint: the key is already written
    expect(await apes.agentIdOf(1)).to.equal(1);
    // ENSIP-25 semantics: the value is the attestation marker "1"; the
    // key itself names the registry (ERC-7930) and the issued agentId
    expect(await apes.metadata(1, key)).to.equal(ethers.hexlify(ethers.toUtf8Bytes("1")));
  });
});
