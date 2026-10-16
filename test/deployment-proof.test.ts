// @ts-nocheck
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashTypedData, keccak256, encodeFunctionResult } from "viem";
const {
  EXPECTED,
  READ_ONLY_RPC_METHODS,
  ROUTER_ABI,
  USER_AGENT,
  createJsonRpcClient,
  decodeRouterCall,
  verifyReadback,
} = await import(
  new URL("../tooling/scripts/deployment/proof.mjs", import.meta.url).href
);

const RUNTIME = "0x6001600055";
const CREATION_INPUT = "0x6002600055";
const ROUTER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SIGNER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FEE_RECIPIENT = "0xcccccccccccccccccccccccccccccccccccccccc";
const DEPLOYMENT_TX = `0x${"12".repeat(32)}`;
const DEPLOYMENT_BLOCK = 123456n;
const DOMAIN = {
  fields: "0x0f",
  name: "PingAppTestRouter",
  version: "1",
  chainId: 4663n,
  verifyingContract: ROUTER,
  salt: `0x${"00".repeat(32)}`,
  extensions: [],
};
const CLAIM = {
  id: `0x${"01".repeat(32)}`,
  recipient: "0x1111111111111111111111111111111111111111",
  relayer: "0x2222222222222222222222222222222222222222",
  deadline: 1234567890n,
};
const claimTypes = {
  ClaimAuth: [
    { name: "id", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "relayer", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
};

function fixtureExpected(overrides = {}) {
  const base = {
    ...EXPECTED,
    chainId: 4663n,
    router: ROUTER,
    runtimeBytes: (RUNTIME.length - 2) / 2,
    runtimeSha256: createHash("sha256")
      .update(Buffer.from(RUNTIME.slice(2), "hex"))
      .digest("hex"),
    runtimeKeccak256: keccak256(RUNTIME).slice(2),
    signer: SIGNER,
    feeRecipient: FEE_RECIPIENT,
    escrowFeeWei: 200000000000000n,
    domain: { ...DOMAIN },
    deploymentTxHash: DEPLOYMENT_TX,
    deploymentBlock: DEPLOYMENT_BLOCK,
    creationInputSha256: createHash("sha256")
      .update(Buffer.from(CREATION_INPUT.slice(2), "hex"))
      .digest("hex"),
  };
  return {
    ...base,
    ...overrides,
    domain: { ...base.domain, ...overrides.domain },
  };
}

function fixtureBuild(expected) {
  return {
    creationInput: CREATION_INPUT,
    creationInputSha256: expected.creationInputSha256,
    runtimeCode: RUNTIME,
    compilerVersion: "0.8.28+commit.7893614a",
    optimizerRuns: 10000,
    evmVersion: "shanghai",
    metadataBytecodeHash: "ipfs",
    sourceCount: 21,
    contractSourceSha256: EXPECTED.sourceSha256,
    immutableReferenceCount: 17,
    immutableByteCount: 544,
  };
}

function fakeRpc(expected, build, overrides = {}) {
  const calls = [];
  const domainHash = hashTypedData({
    domain: {
      name: expected.domain.name,
      version: expected.domain.version,
      chainId: expected.domain.chainId,
      verifyingContract: expected.domain.verifyingContract,
    },
    types: claimTypes,
    primaryType: "ClaimAuth",
    message: CLAIM,
  });

  const rpc = async (method, params = []) => {
    calls.push(method);
    if (method === "eth_chainId")
      return `0x${BigInt(expected.chainId).toString(16)}`;
    if (method === "eth_blockNumber")
      return `0x${(BigInt(expected.deploymentBlock) + 100n).toString(16)}`;
    if (method === "eth_getCode") return RUNTIME;
    if (method === "eth_getTransactionByHash") {
      return {
        hash: DEPLOYMENT_TX,
        to: null,
        blockNumber: `0x${DEPLOYMENT_BLOCK.toString(16)}`,
        blockHash: `0x${"ab".repeat(32)}`,
        input: build.creationInput,
        ...overrides.transaction,
      };
    }
    if (method === "eth_getTransactionReceipt") {
      return {
        status: "0x1",
        transactionHash: DEPLOYMENT_TX,
        contractAddress: ROUTER,
        blockNumber: `0x${DEPLOYMENT_BLOCK.toString(16)}`,
        blockHash: `0x${"ab".repeat(32)}`,
        ...overrides.receipt,
      };
    }
    if (method === "eth_call") {
      const { functionName } = decodeRouterCall(params[0].data);
      const results = {
        signer: SIGNER,
        feeRecipient: FEE_RECIPIENT,
        escrowFee: 200000000000000n,
        eip712Domain: [
          DOMAIN.fields,
          DOMAIN.name,
          DOMAIN.version,
          DOMAIN.chainId,
          DOMAIN.verifyingContract,
          DOMAIN.salt,
          DOMAIN.extensions,
        ],
        hashClaimAuth: domainHash,
      };
      return encodeFunctionResult({
        abi: ROUTER_ABI,
        functionName,
        result: results[functionName],
      });
    }
    throw new Error(`Unexpected RPC method: ${method}`);
  };
  return { rpc, calls };
}

describe("AUD-03 read-only deployment proof", () => {
  it("accepts matching live state and a fresh immutable-patched build", async () => {
    const expected = fixtureExpected();
    const build = fixtureBuild(expected);
    const { rpc, calls } = fakeRpc(expected, build);

    const report = await verifyReadback(
      rpc,
      build,
      expected,
      "2026-10-16T00:00:00.000Z",
    );

    expect(report.checkedBlock).toBe((DEPLOYMENT_BLOCK + 100n).toString());
    expect(report.creationInputMatchesFreshBuild).toBe(true);
    expect(report.runtimeMatchesFreshImmutablePatchedBuild).toBe(true);
    expect(report.claimAuthDomainDigestVerified).toBe(true);
    expect(
      calls.every((method) => READ_ONLY_RPC_METHODS.includes(method)),
    ).toBe(true);
    expect(calls).not.toContain("eth_sendRawTransaction");
  });

  it.each([
    ["chain ID", { chainId: 1n }],
    ["runtime SHA-256", { runtimeSha256: "0".repeat(64) }],
    ["runtime Keccak-256", { runtimeKeccak256: "0".repeat(64) }],
    ["signer", { signer: ROUTER }],
    ["fee recipient", { feeRecipient: SIGNER }],
    ["escrow fee", { escrowFeeWei: 1n }],
    ["EIP-712 domain", { domain: { name: "WrongDomain" } }],
    ["creation transaction", { deploymentTxHash: `0x${"34".repeat(32)}` }],
    ["creation block", { deploymentBlock: 1n }],
    ["creation input hash", { creationInputSha256: "0".repeat(64) }],
  ])("fails closed for a wrong expected %s", async (_label, override) => {
    const expected = fixtureExpected(override);
    const build = fixtureBuild(fixtureExpected());
    const { rpc } = fakeRpc(fixtureExpected(), build);

    await expect(verifyReadback(rpc, build, expected)).rejects.toMatchObject({
      name: "DeploymentProofError",
    });
  });

  it("fails when the RPC is unavailable and sends the required User-Agent", async () => {
    let seenHeaders;
    const rpc = createJsonRpcClient(
      "https://rpc.example.invalid",
      async (_url, init) => {
        seenHeaders = init.headers;
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1237" }),
          { status: 200 },
        );
      },
    );
    await expect(rpc("eth_chainId")).resolves.toBe("0x1237");
    expect(seenHeaders["user-agent"]).toBe(USER_AGENT);

    const unavailable = createJsonRpcClient(
      "https://rpc.example.invalid",
      async () => {
        throw new Error("network unavailable");
      },
    );
    await expect(unavailable("eth_chainId")).rejects.toMatchObject({
      code: "RPC_UNAVAILABLE",
    });
  });

  it("fails when the receipt belongs to a different transaction or block", async () => {
    const expected = fixtureExpected();
    const build = fixtureBuild(expected);
    const wrongTxReceipt = fakeRpc(expected, build, {
      receipt: { transactionHash: `0x${"34".repeat(32)}` },
    });
    await expect(
      verifyReadback(wrongTxReceipt.rpc, build, expected),
    ).rejects.toMatchObject({ name: "DeploymentProofError" });

    const wrongBlockReceipt = fakeRpc(expected, build, {
      receipt: { blockHash: `0x${"cd".repeat(32)}` },
    });
    await expect(
      verifyReadback(wrongBlockReceipt.rpc, build, expected),
    ).rejects.toMatchObject({ name: "DeploymentProofError" });
  });

  it("contains no wallet, signing, broadcast, or private-environment dependency", () => {
    const source = readFileSync(
      new URL(
        "../tooling/scripts/deployment/post-deploy-check.mjs",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).not.toMatch(
      /createWalletClient|sendTransaction|eth_send|privateKey|process\.env|--broadcast/i,
    );
  });
});
