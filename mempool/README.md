# Mock Mempool Server

A local in-memory REST API for Perihelion intent submission and polling, enabling end-to-end SDK→mempool→solver development without a deployed infrastructure.

## Quick Start

```bash
npm run dev --workspace=@perihelion/mempool
```

The server listens on `http://localhost:3000`.

## API

See [`docs/api/mempool-api.yaml`](../docs/api/mempool-api.yaml) for the full
OpenAPI contract, including error responses and known gaps between this
reference implementation and the SDK.

- `POST /intents` — Submit a signed intent. Verifies the EIP-712 signature before storing.
- `GET /intents/:hash` — Fetch an intent's current record by hash.
- `GET /intents?status=pending&chainId=8453&limit=20&offset=0` — List intents,
  optionally filtered by status (`pending`, `settled`, `refunded`, `expired`)
  and/or `chainId`, and paginated with `limit`/`offset`.
- `GET /info` — Discover the EIP-712 domain (`name`, `version`, `chainId`,
  `verifyingContract`) this instance verifies signatures against.

## E2E Flow

```ts
import { PerihelionClient, buildIntent } from "@perihelion/sdk";

const client = new PerihelionClient({ mempoolUrl: "http://localhost:3000" });
const intent = buildIntent({ /* ... */ });
const signed = await client.signIntent(wallet, intent);
const hash = await client.submitIntent(signed);
const result = await client.waitForSettlement(hash);
```

## Integration

The server exposes a `MempoolServer` class with a `updateStatus(hash, status)` method, allowing external coordination (solvers, relayers, test harnesses) to advance intent records through their lifecycle.
