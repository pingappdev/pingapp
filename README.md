# PingApp

[Website](https://getping.tech) · [Open app](https://getping.tech/dashboard) ·
[API health](https://api.getping.tech/health) · [X](https://x.com/pingapp_bank) ·
[Telegram](https://t.me/pingapportal) · [GitHub](https://github.com/pingappdev/pingapp)

API, workers and smart contracts for phone-based crypto payments on Robinhood
Chain: mainnet `4663`, testnet `46630`. SIWE authenticates wallets; SMS verification
links phone numbers. The backend manages identity, signs payment authorizations
and reconciles on-chain transactions.

The stack is Node.js 22+, TypeScript, Fastify 5, Zod, PostgreSQL 17 with Drizzle,
Redis 7 with BullMQ, and viem. Contracts use Solidity 0.8.28, OpenZeppelin and
Foundry v1.5.1.

Two processes share PostgreSQL and Redis:

- `src/server.ts` runs the HTTP API. Routes live under `/v1`; `/health` checks
  database and Redis connectivity.
- `src/worker.ts` runs transfer confirmation, escrow indexing and claims, token
  and price updates, card reconciliation, notifications and cleanup jobs.

`src/modules/` contains auth, phone verification, contacts, payments, assets,
notifications and optional Izipay cards. Module `routes.ts` and `jobs.ts` files are
loaded automatically. Shared integrations live in `src/lib/`, database schema in
`src/db/`, SQL migrations in `drizzle/`, and operator tools in `src/cli/`.

API requests and responses use JSON. Auth uses the HttpOnly `pa_session` cookie;
browser mutations require an allowed Origin and `X-PingApp: 1`. The Izipay webhook
uses provider HMAC verification instead. Token base units use integer strings;
display amounts use decimal strings. [src/config.ts](src/config.ts) validates env
configuration at startup.

Phone numbers are encrypted with AES-256-GCM and indexed using HMAC-SHA256.
Each phone links to one wallet; conflicts require manual review. Recipient lookup
hides wallet addresses. Phone data stays off-chain; transfers remain public.

**Phone payments use a deposit-first flow.** With `ROUTER_ENABLED=true`:

1. `POST /v1/sends/authorize` validates the payment and returns an EIP-712 escrow authorization.
2. The sender approves the token if needed and deposits from their wallet. The worker verifies the deposit.
3. Registered recipients receive a relayed payout. New recipients claim after signing in and verifying their phone.
4. Recipients can submit claims above the relay gas budget themselves. Expired, unclaimed deposits can be refunded.

Legacy transfer/intent routes remain for existing records. Router and card
features are independently gated by `ROUTER_ENABLED` and `CARDS_ENABLED`.

[PingRouter.sol](contracts/src/PingRouter.sol) holds escrowed ETH/ERC-20 assets.
It has no owner or upgrade mechanism; signer, fee recipient and escrow fee are
immutable constructor values.

**Mainnet deployment** (Robinhood Chain, chain ID `4663`):

| Contract | Address | Escrow fee |
| --- | --- | --- |
| PingRouter | `0xA132671d343D93F3e3cf6EdaC8a90B6965E2d3C2` | `0.0002 ETH` |

Deployed at block `88536271`, transaction
`0x1d64fa99c36bcf0c532d956564ee92dc1f24ed5ac54c7aa4209d92a7a5a0ee10`.
Fees accrue to the deployer, `0x36a315a8132a5C658C2D53E6285B6fBB288ff0fB`.

| Contract method | Purpose |
| --- | --- |
| `send` | Execute a signed direct payment. Available on-chain; current phone sends use escrow. |
| `escrow` | Deposit assets with an expiry, fixed ETH fee and ETH claim tip. |
| `claim` | Pay the authorized recipient and the authorized relayer's tip. |
| `refund` | After expiry, anyone can trigger a return of assets and unused tip to the sender. The escrow fee is not refunded. |
| `withdrawOwed` / `withdrawFees` | Withdraw rejected ETH refunds to a chosen address, or accrued fees to the fixed fee recipient. |

EIP-712 signatures bind the chain and contract; deadlines and unique IDs limit
replay. Escrows last 1–60 days and account for tokens actually received. Rebasing
tokens are unsupported; token restrictions can block payouts. Direct transfers to
the router outside its methods have no recovery path.

The backend signer decides who can claim. A compromised signer can redirect
unclaimed funds, but cannot prevent expired refunds or pull tokens from arbitrary
wallets. Startup checks that the configured key matches the contract signer.

**Local development** requires Docker Compose and GNU Make. Docker definitions
and env files live in the separate sibling `../docs/` repository. Configure
`../docs/deploy/backend.env.dev` using `../docs/deploy/backend.env.example`:
DB/Redis, crypto keys, allowed origins, SIWE domains and RPC settings.
Use `SMS_DRIVER=log` locally.

Run from this repository root:

```sh
make npm ARGS=ci             # Install locked backend dependencies in Docker
make api-up                  # Start PostgreSQL, Redis, migrations, API and worker
curl http://127.0.0.1:7410/health
make typecheck test build
make admin ARGS=stats
make logs
```

If Docker needs elevated access, append `DOCKER="sudo docker"` to Make commands.
Without Make, use `docker compose --project-directory . -f
../docs/deploy/app/compose.backend.dev.yml <command>`. Dev ports bind to loopback:
API `7410`, PostgreSQL `7432`, Redis `7479`; optional Anvil `7445`.
`make db-generate` creates migrations; `make db-migrate` applies them.

Backend tests live in `test/` and run with Vitest. The Anvil integration test is
opt-in through `ANVIL_RPC_URL`; use a disposable node. Contract unit, fuzz and
invariant tests run with:

```sh
cd contracts
bin/forge.sh test
```

Fork tests additionally require `ROBINHOOD_RPC_URL`, passed via a private env file
using `FOUNDRY_ENV_FILE`. Contract deployment tooling lives in `contracts/script/`;
`export-abi.sh` generates the checked-in router ABIs.

Production targets the VPS at `127.0.0.1:3410` behind a Cloudflare tunnel. Release
tooling in `../docs/deploy/` packages committed code/configuration and handles DB
backup, migrations, health checks and code rollback. Schema migrations are not
rolled back. Full API and operations references remain in
`../docs/plan/api-contract.md` and `../docs/deploy/RUNBOOK.md`.
