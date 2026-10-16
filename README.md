# PingApp

[Website](https://getping.tech) · [Open app](https://getping.tech/dashboard) ·
[API health](https://api.getping.tech/health) · [X](https://x.com/pingapp_bank) ·
[Telegram](https://t.me/pingapportal) · [GitHub](https://github.com/pingappdev/pingapp)

PingApp provides phone-based crypto payments on Robinhood Chain. Wallets
authenticate with Sign-In with Ethereum (SIWE); phone numbers are used to find
recipients. Phone data is encrypted and indexed in the backend and is not
written to the router contract. The API, worker, web client, and contract all
form part of the security boundary.

## System overview

The backend is Node.js 22+, TypeScript, Fastify 5, PostgreSQL 17, Redis 7,
BullMQ, and viem. The browser and Android client are in [`www/`](www/); the API
and worker are under [`src/`](src/). The worker confirms transfers, processes
escrow claims, and reconciles notifications and optional card activity. API
routes are under `/v1`; `/health` checks the database and Redis.

Phone numbers are encrypted with AES-256-GCM and indexed with HMAC-SHA-256.
Wallet addresses are not returned by recipient lookup. Transfers and contract
activity remain public on the chain.

Contact membership is `unknown` until a user explicitly looks up a phone
number; an absent or expired lookup grant does not mean the number is
unregistered. Discovery grants are short-lived and rate-limited across contact
and send authorization routes, and send authorization checks the current
recipient binding again. Funded claim SMS uses a separate bounded lane, while
free onboarding requests can still exhaust their own allowance. Message
delivery can be delayed or unconfirmed, so users can share the claim link
instead of blindly requesting another message.

Router sends use a deposit-first flow:

1. The API authorizes a payment with an EIP-712 signature.
2. The sender approves the token if needed and deposits into PingRouter. The
   backend worker verifies the deposit.
3. A registered recipient receives a relayed payout. A new recipient signs in
   and verifies the linked phone before claiming.
4. Anyone can trigger a refund after an unclaimed escrow expires.

Legacy intent routes remain for existing records. Router payments and card
features have separate feature flags. Card support depends on the configured
provider and is disabled by default.

## Mainnet router and read-only proof

The deployed router is on Robinhood Chain mainnet, chain ID `4663`:

| Value | Mainnet deployment |
| --- | --- |
| PingRouter | `0xa132671d343d93f3e3cf6edac8a90b6965e2d3c2` |
| EIP-712 domain | `PingRouter`, version `1`, chain ID `4663`, verifying contract above |
| Immutable signer | `0x76c952faf42d0854e4655e33cda6215a419d1477` |
| Immutable fee recipient | `0x36a315a8132a5c658c2d53e6285b6fbb288ff0fb` |
| Escrow fee | `200000000000000` wei (`0.0002 ETH`) |
| Deployment block | `88536271` |
| Creation transaction | `0x1d64fa99c36bcf0c532d956564ee92dc1f24ed5ac54c7aa4209d92a7a5a0ee10` |
| Runtime | 10,025 bytes; SHA-256 `bfd047fd9ab26201551815383193aeda0e1d84ff704a51a3b7061b6d52018050` |

The router has no owner, pause switch, upgrade, or signer rotation. The
read-only proof rebuilds the historical 21-source input with Solidity
`0.8.28`, optimizer runs `10000`, and EVM `shanghai`. It compares the complete
creation input and immutable-patched runtime, then checks the public RPC chain,
router code and hash, signer and fee getters, EIP-712 domain, and linked
creation transaction and receipt. A missing RPC response or mismatch fails the
check.

From a public checkout, run the read-only rebuild and RPC check through the
pinned Docker runner:

```sh
DOCKER="sudo docker" bash scripts/ci/run-deployment-readback.sh
```

The runner prepares Solidity `0.8.28`, installs pinned npm dependencies, and
executes both proof scripts inside Docker. The rebuild step is offline. The
readback uses `https://rpc.mainnet.chain.robinhood.com` by default. The CI
runner uses that default; to use another public HTTPS endpoint, pass
`--rpc-url` directly to the underlying `post-deploy-check.mjs` verifier. The
scripts use read-only RPC methods; they have no transaction signing or
broadcast path. The checked-in proof constants and tests are in
[`tooling/scripts/deployment/`](tooling/scripts/deployment/) and
[`test/deployment-proof.test.ts`](test/deployment-proof.test.ts).

## Contract behavior and limits

PingRouter supports native ETH and ERC-20 transfers. Escrows expire between one
and 60 days. A successful send or escrow permanently consumes its `bytes32` ID;
IDs are shared by both entrypoints and are never cleared after claim or refund.
Use a new unpredictable ID for every payment. A reverted transaction rolls
back the ID reservation.

Claims are rejected at the exact expiry time; refunds become available then.
The router returns the escrow principal and claim tip at refund, but not the
fixed escrow fee. A claim to a wallet that rejects ETH reverts without closing
the escrow. At expiry, if the sender rejects the ETH refund, the contract
credits `owedEth` to that sender; only that sender can withdraw it, to an
address of their choice. Self-claim changes who submits a claim, not its signed
recipient, so it does not let a recipient that rejects ETH receive the payout.
Token refunds still depend on the token allowing a transfer at that time.

Token behavior is not universal:

- Rebasing tokens are unsupported because balances can change while escrowed.
- Escrow deposits record the amount the router actually receives, which
  accommodates fee-on-transfer deposits. Direct `send` uses the requested
  amount and does not account for transfer taxes; do not assume a recipient
  receives the requested amount from a nonstandard token.
- A blacklist or transfer restriction can block a send, claim, or refund until
  the token permits it. The router cannot override token rules.
- Tokens transferred directly to the router outside its methods cannot be
  recovered; the contract has no sweep function.

Tests exercise standard ERC-20s, no-return and false-return tokens,
fee-on-transfer deposits, a blocklist mock, reentrancy attempts, and rejecting
recipients. The pinned fork suite exercises ETH, USDG, and WETH. Its stock-token
case permits a clean revert when the token rejects the transfer; this is not a
promise that arbitrary stock tokens are supported.

## Trust model

| Authority or credential | Role and impact if compromised |
| --- | --- |
| Router signer | Its immutable address authorizes payment data and chooses an escrow claimant. A compromised key can redirect funded, unclaimed escrows before expiry. It cannot change the contract or prevent an expired refund. |
| Relayer | Broadcasts signed payouts and may receive the authorized claim tip. It can delay or withhold a payout, but cannot change the signed recipient, amount, or relayer. |
| Fee recipient | Receives immutable escrow fees. Anyone may call `withdrawFees`, but proceeds always go to this address. Its key controls fees already paid to it, not escrow principal. |
| API, worker, and infrastructure administrators | Control wallet-to-phone lookup, authorization and job processing, databases, deployment, and runtime access. A breach may expose identity data, disrupt service, or misuse server-side signing authority. |
| Phone and IP privacy keys | `PHONE_ENC_KEY` decrypts stored phone numbers; `PHONE_HMAC_SECRET` protects the phone lookup index; `IP_HASH_SALT` separates stored IP hashes. The service needs the keys to operate, so backend access remains trusted. |
| SMS and card-provider credentials | Can incur provider costs or affect messages and card operations. Keep webhook verification and provider credentials private. |
| Source, release, and Android signing access | Can alter the service or distribute a client update. Local APK integrity checks identify the exact file and signer, not its source revision or build process. |

Wallets still control transaction submission and token approvals. Once funds
are deposited in an escrow, however, users rely on the immutable router signer
for the claim authorization until expiry. The contract has no emergency pause
or key-rotation path. Do not infer hardware-backed custody or automatic
recovery from the existence of server-side keys.

## Configuration and local development

No `.env` file is included. Configure the variables through your local
environment or secret manager; replace the placeholders below and never commit
real values. The complete schema and defaults are in [`src/config.ts`](src/config.ts).

```dotenv
NODE_ENV=development
PORT=7410
DATABASE_URL=<PostgreSQL connection URL>
POSTGRES_PASSWORD=<local database password>
REDIS_URL=<Redis connection URL>
CHAIN=robinhood-testnet
PUBLIC_RPC_URL=<optional public HTTPS RPC URL>
PHONE_HMAC_SECRET=<unique 64-character hexadecimal secret>
PHONE_ENC_KEY=<different 64-character hexadecimal secret>
IP_HASH_SALT=<unique random value>
APP_URL=<absolute app URL>
CORS_ORIGINS=<comma-separated browser origins>
SIWE_ALLOWED_DOMAINS=<comma-separated SIWE host names>
SMS_DRIVER=log
SMS_ENABLED=false
ROUTER_ENABLED=false
CARDS_ENABLED=false

# Set these only when the router feature is enabled for the selected chain.
# ROUTER_ADDRESS=<router address>
# ROUTER_DEPLOY_BLOCK=<deployment block>
# ROUTER_SIGNER_KEY=<private key; never commit>
# RELAYER_PRIVATE_KEY=<private key; never commit>

# Set provider credentials only when enabling these services.
# SEVEN_API_KEY=<SMS provider credential>
# IZIPAY_API_KEY=<card provider credential>
# IZIPAY_API_SECRET=<card provider credential>
# IZIPAY_WEBHOOK_SECRET=<webhook verification secret>
# CARD_DATA_ENC_KEY=<separate 64-character hexadecimal key>
```

`DATABASE_URL`, `POSTGRES_PASSWORD`, `REDIS_URL`, the phone keys, IP salt, and
`APP_URL` are required by the backend. The `PHONE_*` keys must be separate
64-character hexadecimal values. To enable router features, set
`ROUTER_ENABLED=true` and configure the matching chain, router address,
`ROUTER_SIGNER_KEY`, and `RELAYER_PRIVATE_KEY`; those signing keys must never be
committed. For a real SMS driver, configure `SEVEN_API_KEY` and a sender. Card
processing also requires provider API credentials, a webhook secret, and a
separate `CARD_DATA_ENC_KEY`. Keep production secrets in the deployment
environment, not in source control.

The API requires reachable PostgreSQL and Redis services. Run Node and Bun
commands inside Docker containers. These Linux examples use host networking so
the containers can reach local development services and bind API port `7410`.
Keep the env file outside the checkout and point its database and Redis URLs at
your local development services (commonly ports `7432` and `7479`).

```sh
docker run --rm --network host \
  --user "$(id -u):$(id -g)" --env HOME=/tmp \
  --env-file /absolute/path/to/local-api.env \
  --volume "$PWD:/work" --workdir /work \
  node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 \
  sh -euc 'npm ci && npm run migrate:dev && npm run dev'
```

Run the worker in a second container with the same user, env file, and volume,
replacing the final command with `sh -euc 'npm run dev:worker'` after the API
container has completed `npm ci`. These examples target Linux Docker with host
networking. For Docker Desktop, use an app-specific network, publish port `7400`
for the web server, and make PostgreSQL and Redis reachable by service name;
set `VITE_API_URL` to an address reachable from the browser. The web client
listens on port `7400` and can run in its own Bun container:

```sh
docker run --rm --network host \
  --user "$(id -u):$(id -g)" --env HOME=/tmp \
  --env VITE_API_URL=http://127.0.0.1:7410 \
  --env VITE_APP_URL=http://127.0.0.1:7400 \
  --env VITE_CHAIN=robinhood-testnet \
  --volume "$PWD/www:/work" --workdir /work \
  oven/bun:1.4.3 \
  sh -euc 'bun install --frozen-lockfile && bun run dev --host 0.0.0.0 --port 7400'
```

For Vercel, set the project root directory to `www`.

## Test map and CI

The main contract and backend test areas are:

| Property | Tests |
| --- | --- |
| Signatures, EIP-712 fields, expiry boundaries, shared/permanent IDs, claims, refunds, fees, and token edge cases | [`PingRouter.t.sol`](contracts/test/PingRouter.t.sol) |
| Native and token balance conservation, owed ETH, and IDs remaining consumed across stateful sequences | [`RouterInvariant.t.sol`](contracts/test/invariant/RouterInvariant.t.sol) |
| Network-specific ETH, USDG, WETH, and restricted stock-token behavior | [`PingRouterFork.t.sol`](contracts/test/fork/PingRouterFork.t.sol) |
| Phone discovery, recipient privacy, and concurrent binding behavior | [`phone-discovery.test.ts`](test/phone-discovery.test.ts), [`f1-discovery.integration.test.ts`](test/f1-discovery.integration.test.ts) |
| Escrow claims, relaying, solvency, and worker recovery | [`privacy-router-claims.test.ts`](test/privacy-router-claims.test.ts), [`privacy-router-relay.test.ts`](test/privacy-router-relay.test.ts), [`router-solvency.test.ts`](test/router-solvency.test.ts), [`router-watcher.test.ts`](test/router-watcher.test.ts) |
| SMS limits and OTP behavior | [`sms-budget.integration.test.ts`](test/sms-budget.integration.test.ts), [`otp.test.ts`](test/otp.test.ts) |
| Rebuild, live deployment readback, and deliberate mismatch failures | [`deployment-proof.test.ts`](test/deployment-proof.test.ts) |

Tests are evidence for the behaviors they exercise, not a proof that every
asset, provider, or deployment setup is safe. The backend CI script creates
disposable PostgreSQL, Redis, and Anvil containers; the contract suite uses an
isolated Foundry container. Neither uses production data. Run these commands
from the repository root with Docker; set `DOCKER="sudo docker"` on hosts that
require it:

```sh
bash scripts/ci/test-backend.sh
bash scripts/ci/test-contracts.sh
bash scripts/ci/run-security-scans.sh
bash scripts/ci/run-slither.sh
bash scripts/ci/test-fork.sh
bash scripts/ci/run-deployment-readback.sh
```

The fork and deployment readback use public RPC and make no transactions. The
security scan covers the public source tree and history. Hosted checks and
repository branch-protection enforcement must be activated and observed in
GitHub before they are considered release gates; workflow files alone are not
evidence that hosted checks passed.

## Android release integrity

The download page keeps a moving `latest` link for convenience. The published
size, SHA-256 digest, and signing-certificate fingerprint are pinned to the
specific `0.1.0` APK in
[`www/public/android-releases/0.1.0.json`](www/public/android-releases/0.1.0.json);
do not reuse those values for another release. They identify the published APK
bytes and signer, but do not establish the source revision or build process.

Build Android production APKs from a local checkout with the Gradle wrapper.
The `prodRelease` output is unsigned unless local release-signing settings are
supplied. Release signing stays local and changes the APK bytes, so generate
release integrity metadata only after signing and verify the final file.

Run [`verify-android-release.sh`](www/scripts/verify-android-release.sh) to
check the pinned `0.1.0` file size, SHA-256 digest, and signer. Use
[`android-apk-integrity.mjs`](www/scripts/android-apk-integrity.mjs) to verify
the identity and digest of other signed APKs against their own metadata.
This release-identity note is separate from the router/API security review.

## Security status and license

An AI-assisted security review informed ongoing remediation. It was not an
independent third-party audit or certification, and its projected scores are
not security results. As of 2026-10-16, remediation and verification are still
in progress; deployment and hosted-check activation remain operational work.
Read [SECURITY.md](SECURITY.md) before reporting a vulnerability.

First-party PingApp code is licensed under the [MIT License](LICENSE). Vendored
dependencies and other third-party components retain their own license terms;
see their included license files.
