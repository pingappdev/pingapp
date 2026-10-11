import fs from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http, parseEther, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// Intentionally fixed: this helper can only deploy to the local Anvil node.
const rpc = 'http://127.0.0.1:7445';
const chain = defineChain({ id: 4663, name: 'Local Robinhood fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const client = createPublicClient({ chain, transport: http(rpc) });
const version = await client.request({ method: 'web3_clientVersion' });
if (!/anvil/i.test(version) || await client.getChainId() !== 4663) throw new Error('Refusing deployment: expected local Anvil chain 4663');
const accounts = await client.request({ method: 'eth_accounts' });
if (!accounts[0] || !accounts[9]) throw new Error('Anvil dev accounts unavailable');

const envPath = '../docs/deploy/router-fork.env.local';
const artifactPath = '../docs/deploy/router-fork-deployment.json';
let env = {};
if (fs.existsSync(envPath)) {
  env = Object.fromEntries(fs.readFileSync(envPath, 'utf8').trim().split('\n').map((line) => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
} else {
  env.ROUTER_SIGNER_KEY = generatePrivateKey().slice(2);
  env.RELAYER_PRIVATE_KEY = generatePrivateKey().slice(2);
  fs.writeFileSync(envPath, Object.entries(env).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600, flag: 'wx' });
}
fs.chmodSync(envPath, 0o600);
const signer = privateKeyToAccount(`0x${env.ROUTER_SIGNER_KEY}`);
const relayer = privateKeyToAccount(`0x${env.RELAYER_PRIVATE_KEY}`);
const { abi, bytecode } = JSON.parse(fs.readFileSync('contracts/out/PingRouter.sol/PingRouter.json', 'utf8'));
const fee = 50_000_000_000_000n;
let deployment;
if (env.ROUTER_ADDRESS && await client.getCode({ address: env.ROUTER_ADDRESS }) && fs.existsSync(artifactPath)) {
  deployment = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
} else {
  const wallet = createWalletClient({ account: accounts[0], chain, transport: http(rpc) });
  const hash = await wallet.deployContract({ abi, bytecode: bytecode.object, args: [signer.address, accounts[9], fee] });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Local router deployment reverted');
  deployment = { rpc, chainId: chain.id, forkBlock: 86069831, address: receipt.contractAddress, deployBlock: Number(receipt.blockNumber), txHash: hash, deployer: accounts[0], signer: signer.address, relayer: relayer.address, feeRecipient: accounts[9], escrowFeeWei: fee.toString() };
}
const onChainSigner = await client.readContract({ address: deployment.address, abi, functionName: 'signer' });
if (onChainSigner.toLowerCase() !== signer.address.toLowerCase()) throw new Error('Local deployment signer mismatch');
await client.request({ method: 'anvil_setBalance', params: [relayer.address, toHex(parseEther('0.1'))] });
Object.assign(env, { ROUTER_ENABLED: 'true', ROUTER_ADDRESS: deployment.address, ROUTER_DEPLOY_BLOCK: String(deployment.deployBlock), ESCROW_CLAIM_TIP_WEI: '50000000000000' });
fs.writeFileSync(envPath, Object.entries(env).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600 });
fs.writeFileSync(artifactPath, `${JSON.stringify(deployment, null, 2)}\n`);
console.log(`ROUTER_ADDRESS=${deployment.address}\nROUTER_DEPLOY_BLOCK=${deployment.deployBlock}`);
