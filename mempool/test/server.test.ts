/**
 * Tests for the mempool server's EIP-712 domain binding. The server verifies
 * intent signatures against a domain built from its configured chainId and
 * escrow (verifyingContract) address; a signature produced under a different
 * domain must be rejected.
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import {
  buildIntent,
  perihelionDomain,
  INTENT_TYPES,
  toMessage,
  type Address,
} from "@perihelion/sdk";
import { privateKeyToAccount } from "viem/accounts";
import { MempoolServer } from "../src/server.js";

const CHAIN_ID = 8453;
const ESCROW: Address = "0x00000000000000000000000000000000000000aa";
const PORT = 3987;
const BASE = `http://localhost:${PORT}`;

const account = privateKeyToAccount(("0x" + "11".repeat(32)) as `0x${string}`);

let server: MempoolServer;

before(async () => {
  server = new MempoolServer({ port: PORT, chainId: CHAIN_ID, verifyingContract: ESCROW });
  await server.start();
});

after(async () => {
  await server.stop();
});

function sampleIntent() {
  return buildIntent({
    user: account.address,
    destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    sourceChainId: CHAIN_ID,
    sourceAsset: "0x0000000000000000000000000000000000000004" as Address,
    sourceAmount: "10000000",
    destAsset: "native",
    minDestAmount: "9900000",
    deadline: Math.floor(Date.now() / 1000) + 600,
  });
}

function sign(intent: ReturnType<typeof buildIntent>, domain: ReturnType<typeof perihelionDomain>) {
  return account.signTypedData({
    domain,
    types: INTENT_TYPES,
    primaryType: "Intent",
    message: toMessage(intent),
  });
}

function submit(intent: unknown, signature: string) {
  return fetch(`${BASE}/intents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent, signature }),
  });
}

test("accepts an intent signed with the server's configured domain", async () => {
  const intent = sampleIntent();
  const signature = await sign(intent, perihelionDomain(CHAIN_ID, ESCROW));

  const res = await submit(intent, signature);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { hash: string };
  assert.match(body.hash, /^0x[0-9a-f]{64}$/);
});

test("rejects an intent signed under a mismatched chainId", async () => {
  const intent = sampleIntent();
  // Same escrow, wrong chain — signature recovers a different signer.
  const signature = await sign(intent, perihelionDomain(999, ESCROW));

  const res = await submit(intent, signature);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "Invalid signature");
});

test("rejects an intent signed under a mismatched verifyingContract", async () => {
  const intent = sampleIntent();
  const otherEscrow: Address = "0x00000000000000000000000000000000000000bb";
  const signature = await sign(intent, perihelionDomain(CHAIN_ID, otherEscrow));

  const res = await submit(intent, signature);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "Invalid signature");
});

// ─── Issue 348: path/query parameter validation on GET /intents ────────────

test("GET /intents/:hash returns 400 for a malformed hash instead of 404", async () => {
  const res = await fetch(`${BASE}/intents/not-a-hash`);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /hash/i);
});

test("GET /intents/:hash returns 400 for a hash of the wrong length", async () => {
  const res = await fetch(`${BASE}/intents/0x${"ab".repeat(10)}`);
  assert.equal(res.status, 400);
});

test("GET /intents/:hash returns 404 (not 400) for a well-formed but unknown hash", async () => {
  const res = await fetch(`${BASE}/intents/0x${"ab".repeat(32)}`);
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "Intent not found");
});

test("GET /intents/:hash lookup is case-insensitive", async () => {
  const intent = sampleIntent();
  const signature = await sign(intent, perihelionDomain(CHAIN_ID, ESCROW));
  const submitRes = await submit(intent, signature);
  const { hash } = (await submitRes.json()) as { hash: string };

  const upperHashUrl = `${BASE}/intents/0x${hash.slice(2).toUpperCase()}`;
  const res = await fetch(upperHashUrl);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { hash: string };
  assert.equal(body.hash, hash);
});

test("GET /intents?status=<invalid> returns 400", async () => {
  const res = await fetch(`${BASE}/intents?status=not-a-real-status`);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /status must be one of/);
});

test("GET /intents?status=<repeated> returns 400 instead of silently comparing an array", async () => {
  const res = await fetch(`${BASE}/intents?status=pending&status=settled`);
  assert.equal(res.status, 400);
});

test("GET /intents?status=pending returns only matching records", async () => {
  const res = await fetch(`${BASE}/intents?status=pending`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Array<{ status: string }>;
  assert.ok(body.every((r) => r.status === "pending"));
});
