import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeFunctionResult,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  encodeFunctionResult,
  hashTypedData,
  keccak256,
  stringToHex,
} from "viem";

export const DEFAULT_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const USER_AGENT =
  "PingApp-PostDeployCheck/1.0 (read-only deployment proof)";
export const EXPECTED = Object.freeze({
  chainId: 4663n,
  router: "0xa132671d343d93f3e3cf6edac8a90b6965e2d3c2",
  runtimeBytes: 10025,
  runtimeSha256:
    "bfd047fd9ab26201551815383193aeda0e1d84ff704a51a3b7061b6d52018050",
  runtimeKeccak256:
    "fb009f119e63a8a60657a191313f159d95d180dfb7ca00e5935a5f249025395d",
  signer: "0x76c952faf42d0854e4655e33cda6215a419d1477",
  feeRecipient: "0x36a315a8132a5c658c2d53e6285b6fbb288ff0fb",
  escrowFeeWei: 200000000000000n,
  domain: Object.freeze({
    fields: "0x0f",
    name: "PingRouter",
    version: "1",
    chainId: 4663n,
    verifyingContract: "0xa132671d343d93f3e3cf6edac8a90b6965e2d3c2",
    salt: `0x${"00".repeat(32)}`,
    extensions: Object.freeze([]),
  }),
  deploymentTxHash:
    "0x1d64fa99c36bcf0c532d956564ee92dc1f24ed5ac54c7aa4209d92a7a5a0ee10",
  deploymentBlock: 88536271n,
  compilerVersion: "0.8.28+commit.7893614a",
  optimizerRuns: 10000,
  evmVersion: "shanghai",
  sourceSha256:
    "49bfe4cba87e22b615a69ecfc8ab7101f9b3324207f686ce966388c728966dda",
  sourceCount: 21,
  immutableReferenceCount: 17,
  immutableByteCount: 544,
  creationInputSha256:
    "1265c734bf77f556d566a12d0c95dc4ba36f011c068e2043af496a6edb3cd27c",
});

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CONTRACTS_ROOT = resolve(APP_ROOT, "contracts");

export const HISTORICAL_SOURCE_PATHS = Object.freeze([
  "lib/openzeppelin-contracts/contracts/interfaces/IERC1363.sol",
  "lib/openzeppelin-contracts/contracts/interfaces/IERC165.sol",
  "lib/openzeppelin-contracts/contracts/interfaces/IERC20.sol",
  "lib/openzeppelin-contracts/contracts/interfaces/IERC5267.sol",
  "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol",
  "lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol",
  "lib/openzeppelin-contracts/contracts/utils/Address.sol",
  "lib/openzeppelin-contracts/contracts/utils/Errors.sol",
  "lib/openzeppelin-contracts/contracts/utils/Panic.sol",
  "lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol",
  "lib/openzeppelin-contracts/contracts/utils/ShortStrings.sol",
  "lib/openzeppelin-contracts/contracts/utils/StorageSlot.sol",
  "lib/openzeppelin-contracts/contracts/utils/Strings.sol",
  "lib/openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol",
  "lib/openzeppelin-contracts/contracts/utils/cryptography/EIP712.sol",
  "lib/openzeppelin-contracts/contracts/utils/cryptography/MessageHashUtils.sol",
  "lib/openzeppelin-contracts/contracts/utils/introspection/IERC165.sol",
  "lib/openzeppelin-contracts/contracts/utils/math/Math.sol",
  "lib/openzeppelin-contracts/contracts/utils/math/SafeCast.sol",
  "lib/openzeppelin-contracts/contracts/utils/math/SignedMath.sol",
  "src/PingRouter.sol",
]);

const COMPILER_SETTINGS = Object.freeze({
  remappings: [
    "@openzeppelin/=lib/openzeppelin-contracts/",
    "forge-std/=lib/forge-std/src/",
    "ds-test/=lib/openzeppelin-contracts/lib/forge-std/lib/ds-test/src/",
    "erc4626-tests/=lib/openzeppelin-contracts/lib/erc4626-tests/",
    "halmos-cheatcodes/=lib/openzeppelin-contracts/lib/halmos-cheatcodes/src/",
    "openzeppelin-contracts/=lib/openzeppelin-contracts/",
  ],
  optimizer: { enabled: true, runs: 10000 },
  metadata: {
    useLiteralContent: false,
    bytecodeHash: "ipfs",
    appendCBOR: true,
  },
  outputSelection: {
    "*": {
      "": ["ast"],
      "*": [
        "abi",
        "evm.bytecode.object",
        "evm.bytecode.sourceMap",
        "evm.bytecode.linkReferences",
        "evm.deployedBytecode.object",
        "evm.deployedBytecode.sourceMap",
        "evm.deployedBytecode.linkReferences",
        "evm.deployedBytecode.immutableReferences",
        "evm.methodIdentifiers",
        "metadata",
      ],
    },
  },
  evmVersion: "shanghai",
  viaIR: false,
  libraries: {},
});

export const ROUTER_ABI = [
  {
    type: "function",
    name: "signer",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "feeRecipient",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "escrowFee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "eip712Domain",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "fields", type: "bytes1" },
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "extensions", type: "uint256[]" },
    ],
  },
  {
    type: "function",
    name: "hashClaimAuth",
    stateMutability: "view",
    inputs: [
      {
        name: "a",
        type: "tuple",
        components: [
          { name: "id", type: "bytes32" },
          { name: "recipient", type: "address" },
          { name: "relayer", type: "address" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [{ type: "bytes32" }],
  },
];

export const READ_ONLY_RPC_METHODS = Object.freeze([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getCode",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_call",
]);

export class DeploymentProofError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "DeploymentProofError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new DeploymentProofError(code, message, options);
}

function sha256Hex(hex) {
  if (!/^0x(?:[0-9a-f]{2})*$/i.test(hex))
    fail("INVALID_HEX", "Expected even-length hex data.");
  return createHash("sha256")
    .update(Buffer.from(hex.slice(2), "hex"))
    .digest("hex");
}

function normalizeHex(hex) {
  return typeof hex === "string" ? hex.toLowerCase() : "";
}

function normalizeAddress(address) {
  return typeof address === "string" ? address.toLowerCase() : "";
}

function assertEqual(actual, expected, field, normalize = (value) => value) {
  if (normalize(actual) !== normalize(expected)) {
    fail("MISMATCH", `${field} mismatch.`);
  }
}

function compilerInput() {
  const sources = {};
  for (const sourcePath of HISTORICAL_SOURCE_PATHS) {
    let content;
    try {
      content = readFileSync(resolve(CONTRACTS_ROOT, sourcePath), "utf8");
    } catch (error) {
      fail(
        "BUILD_SOURCE_MISSING",
        `Historical source is missing: ${sourcePath}.`,
        { cause: error },
      );
    }
    sources[sourcePath] = { content };
  }
  return { language: "Solidity", sources, settings: COMPILER_SETTINGS };
}

function compilerVersion(solcCommand) {
  const result = spawnSync(solcCommand, ["--version"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail(
      "BUILD_COMPILER_UNAVAILABLE",
      "Solidity 0.8.28 compiler is unavailable on PATH.",
      { cause: result.error },
    );
  }
  const match = `${result.stdout}\n${result.stderr}`.match(
    /Version:\s*(0\.8\.28\+commit\.7893614a)/,
  );
  if (!match)
    fail(
      "BUILD_COMPILER_MISMATCH",
      "Expected Solidity 0.8.28+commit.7893614a.",
    );
  return match[1];
}

function compile(solcCommand, input) {
  const result = spawnSync(solcCommand, ["--standard-json"], {
    input: JSON.stringify(input),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail("BUILD_COMPILATION_FAILED", "Solidity 0.8.28 compilation failed.", {
      cause: result.error,
    });
  }
  const jsonStart = result.stdout.indexOf("{");
  if (jsonStart < 0)
    fail(
      "BUILD_INVALID_OUTPUT",
      "Solidity compiler did not return standard JSON.",
    );
  let output;
  try {
    output = JSON.parse(result.stdout.slice(jsonStart));
  } catch (error) {
    fail("BUILD_INVALID_OUTPUT", "Solidity compiler returned invalid JSON.", {
      cause: error,
    });
  }
  const errors = (output.errors ?? []).filter(
    (diagnostic) => diagnostic.severity === "error",
  );
  if (errors.length) {
    fail(
      "BUILD_COMPILATION_FAILED",
      `Solidity reported ${errors.length} compilation error(s).`,
    );
  }
  return output;
}

function mapImmutableNames(sourceOutputs) {
  const names = new Map();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (
      value.nodeType === "VariableDeclaration" &&
      value.mutability === "immutable" &&
      value.id !== undefined
    ) {
      names.set(String(value.id), value.name);
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else {
      for (const child of Object.values(value)) visit(child);
    }
  };
  for (const sourceOutput of Object.values(sourceOutputs))
    visit(sourceOutput.ast);
  return names;
}

function word(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function addressWord(address) {
  return `0x${address.toLowerCase().slice(2).padStart(64, "0")}`;
}

function shortStringWord(value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > 31)
    fail(
      "BUILD_IMMUTABLE_UNSUPPORTED",
      "EIP-712 domain string exceeds ShortString capacity.",
    );
  const result = Buffer.alloc(32);
  bytes.copy(result);
  result[31] |= bytes.length;
  return `0x${result.toString("hex")}`;
}

function domainSeparator(expected) {
  const typeHash = keccak256(
    stringToHex(
      "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    ),
  );
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        typeHash,
        keccak256(stringToHex(expected.domain.name)),
        keccak256(stringToHex(expected.domain.version)),
        expected.domain.chainId,
        expected.domain.verifyingContract,
      ],
    ),
  );
}

function expectedImmutableWords(expected) {
  return new Map([
    ["_cachedDomainSeparator", domainSeparator(expected)],
    ["_cachedChainId", word(expected.domain.chainId)],
    ["_cachedThis", addressWord(expected.router)],
    ["_hashedName", keccak256(stringToHex(expected.domain.name))],
    ["_hashedVersion", keccak256(stringToHex(expected.domain.version))],
    ["_name", shortStringWord(expected.domain.name)],
    ["_version", shortStringWord(expected.domain.version)],
    ["signer", addressWord(expected.signer)],
    ["feeRecipient", addressWord(expected.feeRecipient)],
    ["escrowFee", word(expected.escrowFeeWei)],
  ]);
}

function patchRuntime(template, references, immutableNames, immutableWords) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(template)) {
    fail(
      "BUILD_INVALID_RUNTIME",
      "Compiler runtime contains unresolved libraries or invalid bytecode.",
    );
  }
  const bytes = Buffer.from(template, "hex");
  let referenceCount = 0;
  let immutableByteCount = 0;
  for (const [id, ranges] of Object.entries(references ?? {})) {
    const name = immutableNames.get(id);
    const expectedWord = immutableWords.get(name);
    if (!name || !expectedWord)
      fail(
        "BUILD_IMMUTABLE_UNSUPPORTED",
        `Unrecognized immutable reference ${id}.`,
      );
    const valueBytes = Buffer.from(expectedWord.slice(2), "hex");
    for (const range of ranges) {
      if (
        range.length !== valueBytes.length ||
        range.start + range.length > bytes.length
      ) {
        fail(
          "BUILD_IMMUTABLE_UNSUPPORTED",
          `Unexpected immutable reference size for ${name}.`,
        );
      }
      bytes.set(valueBytes, range.start);
      referenceCount += 1;
      immutableByteCount += range.length;
    }
  }
  return {
    runtimeCode: `0x${bytes.toString("hex")}`,
    referenceCount,
    immutableByteCount,
    immutableNames: [
      ...new Set(
        Object.keys(references ?? {}).map((id) => immutableNames.get(id)),
      ),
    ].sort(),
  };
}

export function encodeConstructorArgs(expected = EXPECTED) {
  return encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint256" }],
    [expected.signer, expected.feeRecipient, expected.escrowFeeWei],
  );
}

export function buildHistoricalProof({
  expected = EXPECTED,
  solcCommand = "solc",
} = {}) {
  const version = compilerVersion(solcCommand);
  const input = compilerInput();
  const output = compile(solcCommand, input);
  const compiled = output.contracts?.["src/PingRouter.sol"]?.PingRouter;
  if (
    !compiled?.evm?.bytecode?.object ||
    !compiled.evm.deployedBytecode?.object
  ) {
    fail(
      "BUILD_ARTIFACT_MISSING",
      "Solidity output is missing PingRouter creation or runtime bytecode.",
    );
  }

  const metadata = JSON.parse(compiled.metadata);
  if (
    metadata.compiler?.version !== expected.compilerVersion ||
    metadata.settings?.optimizer?.enabled !== true ||
    metadata.settings?.optimizer?.runs !== expected.optimizerRuns ||
    metadata.settings?.evmVersion !== expected.evmVersion ||
    metadata.settings?.metadata?.bytecodeHash !== "ipfs"
  ) {
    fail(
      "BUILD_SETTINGS_MISMATCH",
      "Compiled metadata does not match the reviewed historical settings.",
    );
  }

  const sourceNames = Object.keys(input.sources).sort();
  const sourceHashes = Object.fromEntries(
    sourceNames.map((name) => [
      name,
      createHash("sha256").update(input.sources[name].content).digest("hex"),
    ]),
  );
  if (
    sourceNames.length !== expected.sourceCount ||
    sourceHashes["src/PingRouter.sol"] !== expected.sourceSha256
  ) {
    fail(
      "BUILD_SOURCE_MISMATCH",
      "The 21-source historical input does not match the reviewed source set.",
    );
  }

  const constructorArgs = encodeConstructorArgs(expected);
  const creationInput = `0x${compiled.evm.bytecode.object}${constructorArgs.slice(2)}`;
  const creationInputSha256 = sha256Hex(creationInput);
  if (
    expected.creationInputSha256 &&
    creationInputSha256 !== expected.creationInputSha256
  ) {
    fail(
      "BUILD_CREATION_INPUT_MISMATCH",
      "Fresh creation input differs from the reviewed deployment input.",
    );
  }

  const immutableNames = mapImmutableNames(output.sources ?? {});
  const patched = patchRuntime(
    compiled.evm.deployedBytecode.object,
    compiled.evm.deployedBytecode.immutableReferences,
    immutableNames,
    expectedImmutableWords(expected),
  );
  if (
    patched.referenceCount !== expected.immutableReferenceCount ||
    patched.immutableByteCount !== expected.immutableByteCount
  ) {
    fail(
      "BUILD_IMMUTABLE_COUNT_MISMATCH",
      "Compiler immutable references differ from the reviewed artifact.",
    );
  }

  const runtimeSha256 = sha256Hex(patched.runtimeCode);
  const runtimeKeccak256 = keccak256(patched.runtimeCode);
  if (
    runtimeSha256 !== expected.runtimeSha256 ||
    normalizeHex(runtimeKeccak256) !== `0x${expected.runtimeKeccak256}`
  ) {
    fail(
      "BUILD_RUNTIME_MISMATCH",
      "Immutable-patched historical runtime does not match the reviewed full runtime.",
    );
  }

  return {
    compilerVersion: version,
    sourceCount: sourceNames.length,
    sourceNames,
    sourceHashes,
    contractSourceSha256: sourceHashes["src/PingRouter.sol"],
    optimizerRuns: metadata.settings.optimizer.runs,
    evmVersion: metadata.settings.evmVersion,
    metadataBytecodeHash: metadata.settings.metadata.bytecodeHash,
    creationInput,
    creationInputBytes: (creationInput.length - 2) / 2,
    creationInputSha256,
    constructorArgs,
    constructorArgsSha256: sha256Hex(constructorArgs),
    runtimeCode: patched.runtimeCode,
    runtimeBytes: (patched.runtimeCode.length - 2) / 2,
    runtimeSha256,
    runtimeKeccak256: normalizeHex(runtimeKeccak256),
    immutableReferenceCount: patched.referenceCount,
    immutableByteCount: patched.immutableByteCount,
    immutableNames: patched.immutableNames,
  };
}

export function createJsonRpcClient(
  rpcUrl = DEFAULT_RPC_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
) {
  let requestId = 0;
  return async (method, params = []) => {
    if (!READ_ONLY_RPC_METHODS.includes(method))
      fail("RPC_METHOD_BLOCKED", `RPC method ${method} is not allowed.`);
    const id = ++requestId;
    let response;
    let body;
    try {
      response = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok)
        fail(
          "RPC_UNAVAILABLE",
          `Read-only RPC returned HTTP ${response.status}.`,
        );
      body = await response.json();
    } catch (error) {
      if (error instanceof DeploymentProofError) throw error;
      fail("RPC_UNAVAILABLE", "Read-only RPC request failed.", {
        cause: error,
      });
    }
    if (!body || body.id !== id || body.jsonrpc !== "2.0") {
      fail(
        "RPC_UNAVAILABLE",
        "Read-only RPC returned an invalid JSON-RPC response.",
      );
    }
    if (body.error || !Object.hasOwn(body, "result")) {
      fail("RPC_UNAVAILABLE", "Read-only RPC returned an error response.");
    }
    return body.result;
  };
}

const CLAIM_PROBE = Object.freeze({
  id: `0x${"01".repeat(32)}`,
  recipient: "0x1111111111111111111111111111111111111111",
  relayer: "0x2222222222222222222222222222222222222222",
  deadline: 1234567890n,
});
const CLAIM_TYPES = {
  ClaimAuth: [
    { name: "id", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "relayer", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
};

function domainDto(decoded) {
  const [fields, name, version, chainId, verifyingContract, salt, extensions] =
    decoded;
  return {
    fields: normalizeHex(fields),
    name,
    version,
    chainId: BigInt(chainId).toString(),
    verifyingContract: normalizeAddress(verifyingContract),
    salt: normalizeHex(salt),
    extensions: extensions.map((extension) => BigInt(extension).toString()),
  };
}

function expectedDomainDto(expected) {
  return {
    fields: normalizeHex(expected.domain.fields),
    name: expected.domain.name,
    version: expected.domain.version,
    chainId: BigInt(expected.domain.chainId).toString(),
    verifyingContract: normalizeAddress(expected.domain.verifyingContract),
    salt: normalizeHex(expected.domain.salt),
    extensions: expected.domain.extensions.map((extension) =>
      BigInt(extension).toString(),
    ),
  };
}

async function callContract(rpc, expected, blockTag, functionName, args = []) {
  const data = encodeFunctionData({ abi: ROUTER_ABI, functionName, args });
  const raw = await rpc("eth_call", [{ to: expected.router, data }, blockTag]);
  try {
    return decodeFunctionResult({ abi: ROUTER_ABI, functionName, data: raw });
  } catch (error) {
    fail(
      "RPC_INVALID_CONTRACT_RESPONSE",
      `Could not decode ${functionName} response.`,
      { cause: error },
    );
  }
}

export async function verifyReadback(
  rpc,
  build,
  expected = EXPECTED,
  checkedAt = new Date().toISOString(),
) {
  if (!build?.creationInput || !build?.runtimeCode)
    fail("BUILD_REQUIRED", "A successful historical rebuild is required.");
  if (build.creationInputSha256 !== expected.creationInputSha256) {
    fail(
      "BUILD_CREATION_INPUT_MISMATCH",
      "Fresh creation input does not match the reviewed input hash.",
    );
  }

  const chainIdHex = await rpc("eth_chainId");
  assertEqual(BigInt(chainIdHex), BigInt(expected.chainId), "chain ID");
  const blockHex = await rpc("eth_blockNumber");
  const checkedBlock = BigInt(blockHex);
  if (checkedBlock < BigInt(expected.deploymentBlock)) {
    fail(
      "MISMATCH",
      "Checked chain head predates the recorded deployment block.",
    );
  }
  const blockTag = `0x${checkedBlock.toString(16)}`;

  const runtimeCode = await rpc("eth_getCode", [expected.router, blockTag]);
  if (!runtimeCode || runtimeCode === "0x")
    fail("MISMATCH", "Router runtime is empty.");
  const runtimeBytes = (runtimeCode.length - 2) / 2;
  if (runtimeBytes !== expected.runtimeBytes)
    fail("MISMATCH", "Router runtime byte length mismatch.");
  const runtimeSha256 = sha256Hex(runtimeCode);
  const runtimeKeccak256 = normalizeHex(keccak256(runtimeCode));
  assertEqual(runtimeSha256, expected.runtimeSha256, "runtime SHA-256");
  assertEqual(
    runtimeKeccak256,
    `0x${expected.runtimeKeccak256}`,
    "runtime Keccak-256",
    normalizeHex,
  );
  assertEqual(
    normalizeHex(runtimeCode),
    normalizeHex(build.runtimeCode),
    "complete immutable-patched runtime",
  );

  const [signer, feeRecipient, escrowFee] = await Promise.all([
    callContract(rpc, expected, blockTag, "signer"),
    callContract(rpc, expected, blockTag, "feeRecipient"),
    callContract(rpc, expected, blockTag, "escrowFee"),
  ]);
  assertEqual(
    normalizeAddress(signer),
    normalizeAddress(expected.signer),
    "signer",
  );
  assertEqual(
    normalizeAddress(feeRecipient),
    normalizeAddress(expected.feeRecipient),
    "fee recipient",
  );
  assertEqual(BigInt(escrowFee), BigInt(expected.escrowFeeWei), "escrow fee");

  const decodedDomain = await callContract(
    rpc,
    expected,
    blockTag,
    "eip712Domain",
  );
  const actualDomain = domainDto(decodedDomain);
  if (
    JSON.stringify(actualDomain) !== JSON.stringify(expectedDomainDto(expected))
  ) {
    fail("MISMATCH", "EIP-712 domain mismatch.");
  }

  const actualClaimHash = await callContract(
    rpc,
    expected,
    blockTag,
    "hashClaimAuth",
    [CLAIM_PROBE],
  );
  const expectedClaimHash = hashTypedData({
    domain: {
      name: expected.domain.name,
      version: expected.domain.version,
      chainId: BigInt(expected.domain.chainId),
      verifyingContract: expected.domain.verifyingContract,
    },
    types: CLAIM_TYPES,
    primaryType: "ClaimAuth",
    message: CLAIM_PROBE,
  });
  assertEqual(
    normalizeHex(actualClaimHash),
    normalizeHex(expectedClaimHash),
    "EIP-712 claim digest",
  );

  const [transaction, receipt] = await Promise.all([
    rpc("eth_getTransactionByHash", [expected.deploymentTxHash]),
    rpc("eth_getTransactionReceipt", [expected.deploymentTxHash]),
  ]);
  if (!transaction || !receipt)
    fail("MISMATCH", "Creation transaction or receipt is unavailable.");
  assertEqual(
    normalizeHex(transaction.hash),
    normalizeHex(expected.deploymentTxHash),
    "creation transaction hash",
  );
  if (transaction.to !== null)
    fail(
      "MISMATCH",
      "Recorded deployment transaction is not a contract creation.",
    );
  assertEqual(
    BigInt(transaction.blockNumber),
    BigInt(expected.deploymentBlock),
    "creation transaction block",
  );
  assertEqual(
    normalizeHex(transaction.input ?? transaction.data),
    normalizeHex(build.creationInput),
    "creation input",
  );
  assertEqual(
    sha256Hex(transaction.input ?? transaction.data),
    expected.creationInputSha256,
    "creation input SHA-256",
  );
  assertEqual(
    normalizeHex(receipt.transactionHash),
    normalizeHex(expected.deploymentTxHash),
    "creation receipt transaction hash",
  );
  const transactionBlockHash = normalizeHex(transaction.blockHash);
  const receiptBlockHash = normalizeHex(receipt.blockHash);
  if (
    !/^0x[0-9a-f]{64}$/.test(transactionBlockHash) ||
    !/^0x[0-9a-f]{64}$/.test(receiptBlockHash)
  ) {
    fail(
      "MISMATCH",
      "Creation transaction or receipt is missing a valid block hash.",
    );
  }
  assertEqual(
    transactionBlockHash,
    receiptBlockHash,
    "creation transaction/receipt block hash",
  );
  assertEqual(normalizeHex(receipt.status), "0x1", "creation receipt status");
  assertEqual(
    normalizeAddress(receipt.contractAddress),
    normalizeAddress(expected.router),
    "receipt contract address",
  );
  assertEqual(
    BigInt(receipt.blockNumber),
    BigInt(expected.deploymentBlock),
    "receipt block",
  );

  return {
    checkedAt,
    scope:
      "Read-only public RPC verification and fresh historical source rebuild; no transaction-capable client used.",
    rpcUserAgentProvided: true,
    chainId: Number(expected.chainId),
    checkedBlock: checkedBlock.toString(),
    router: expected.router,
    deploymentTransaction: expected.deploymentTxHash,
    deploymentBlock: BigInt(expected.deploymentBlock).toString(),
    receiptSuccessful: true,
    receiptContractMatches: true,
    creationInputMatchesFreshBuild: true,
    creationInputBytes: (build.creationInput.length - 2) / 2,
    creationInputSha256: build.creationInputSha256,
    runtimeBytes,
    runtimeSha256,
    runtimeKeccak256,
    runtimeMatchesFreshImmutablePatchedBuild: true,
    getters: {
      signer: normalizeAddress(signer),
      feeRecipient: normalizeAddress(feeRecipient),
      escrowFeeWei: BigInt(escrowFee).toString(),
    },
    domain: actualDomain,
    claimAuthDomainDigestVerified: true,
    compiler: {
      version: build.compilerVersion,
      optimizerRuns: build.optimizerRuns,
      evmVersion: build.evmVersion,
      metadataBytecodeHash: build.metadataBytecodeHash,
      sourceCount: build.sourceCount,
      contractSourceSha256: build.contractSourceSha256,
      immutableReferenceCount: build.immutableReferenceCount,
      immutableByteCount: build.immutableByteCount,
    },
  };
}

export async function verifyDeployment({
  rpcUrl = DEFAULT_RPC_URL,
  fetchImpl = globalThis.fetch,
  expected = EXPECTED,
  build = buildHistoricalProof({ expected }),
  checkedAt = new Date().toISOString(),
} = {}) {
  return verifyReadback(
    createJsonRpcClient(rpcUrl, fetchImpl),
    build,
    expected,
    checkedAt,
  );
}

export function encodeRouterResult(functionName, value) {
  return encodeFunctionResult({ abi: ROUTER_ABI, functionName, result: value });
}

export function decodeRouterCall(data) {
  return decodeFunctionData({ abi: ROUTER_ABI, data });
}
