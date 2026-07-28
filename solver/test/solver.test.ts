/**
 * Tests for solver signature verification caching and hash validation.
 */

import assert from "node:assert/strict";
import { test, mock } from "node:test";
import {
  buildIntent,
  hashIntent,
  perihelionDomain,
  type IntentRecord,
  type Hex,
} from "@perihelion/sdk";
import { Solver, FatalError, type Executor, type Logger } from "../src/solver.js";
import type { SolverConfig } from "../src/config.js";
import type { InventoryProvider } from "../src/inventory.js";

// Test fixtures
const CHAIN_ID = 8453;
const ESCROW_ADDRESS = "0x0000000000000000000000000000000000000001" as const;
const USER_ADDRESS = "0x0000000000000000000000000000000000000002" as const;

const domain = perihelionDomain(CHAIN_ID, ESCROW_ADDRESS);

const baseConfig: SolverConfig = {
  mempoolUrl: "http://localhost:8080",
  solverAddress: "0x0000000000000000000000000000000000000003" as const,
  sourceChainId: CHAIN_ID,
  escrowAddress: ESCROW_ADDRESS,
  minMarginBps: 10,
  pollIntervalMs: 1000,
  supportedDestAssets: ["native"],
  verificationCacheSize: 100,
};

function buildTestIntent() {
  return buildIntent({
    user: USER_ADDRESS,
    destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    sourceChainId: CHAIN_ID,
    sourceAsset: "0x0000000000000000000000000000000000000004" as const,
    sourceAmount: "1000000",
    destAsset: "native",
    minDestAmount: "990000",
    deadline: Math.floor(Date.now() / 1000) + 600,
  });
}

function buildTestRecord(intent = buildTestIntent()): IntentRecord {
  const hash = hashIntent(intent, domain);
  return {
    intent,
    signature: "0xdeadbeef" as Hex,
    hash,
    status: "pending",
    createdAt: Math.floor(Date.now() / 1000),
  };
}

test("verifies signature only once for the same intent hash", async () => {
  const intent = buildTestIntent();
  const record = buildTestRecord(intent);

  let verifyCallCount = 0;
  const mockVerify = mock.fn(async () => {
    verifyCallCount++;
    return true;
  });

  const mockLogger: Logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  const mockExecutor: Executor = {
    fill: async () => ({ settlementTx: "0xfilled" }),
  };

  // Mock fetch to return the same intent twice
  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => [record],
  })) as any;

  const solver = new Solver(baseConfig, mockExecutor, mockLogger, undefined, undefined, mockVerify);

  // First tick - should verify
  await solver.tick();
  assert.equal(verifyCallCount, 1, "should verify on first encounter");

  // Second tick with same intent - should use cache
  await solver.tick();
  assert.equal(
    verifyCallCount,
    1,
    "should not verify again for same hash (cached)"
  );
});

test("rejects intent with hash mismatch", async () => {
  const intent = buildTestIntent();
  // A well-formed 32-byte hash that deliberately differs from the real one.
  const wrongHash = ("0x" + "11".repeat(32)) as Hex;

  const record: IntentRecord = {
    intent,
    signature: "0xdeadbeef" as Hex,
    hash: wrongHash, // Mempool returned wrong hash
    status: "pending",
    createdAt: Math.floor(Date.now() / 1000),
  };

  const warnings: string[] = [];
  const mockLogger: Logger = {
    info: () => {},
    warn: (msg, meta) => {
      warnings.push(msg);
    },
    error: () => {},
  };

  const mockExecutor: Executor = {
    fill: async () => {
      throw new Error("fill should not be called");
    },
  };

  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => [record],
  })) as any;

  const solver = new Solver(baseConfig, mockExecutor, mockLogger);
  await solver.tick();

  assert.ok(
    warnings.some((w) => w.includes("hash mismatch")),
    "should warn about hash mismatch"
  );
});

test("caches invalid signatures to avoid re-verification", async () => {
  const intent = buildTestIntent();
  const record = buildTestRecord(intent);

  let verifyCallCount = 0;
  const mockVerify = mock.fn(async () => {
    verifyCallCount++;
    return false; // Invalid signature
  });

  const warnings: string[] = [];
  const mockLogger: Logger = {
    info: () => {},
    warn: (msg) => {
      warnings.push(msg);
    },
    error: () => {},
  };

  const mockExecutor: Executor = {
    fill: async () => {
      throw new Error("fill should not be called for invalid signature");
    },
  };

  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => [record],
  })) as any;

  const solver = new Solver(baseConfig, mockExecutor, mockLogger, undefined, undefined, mockVerify);

  // First tick - should verify and reject
  await solver.tick();
  assert.equal(verifyCallCount, 1, "should verify on first encounter");
  assert.ok(
    warnings.some((w) => w.includes("invalid signature")),
    "should warn about invalid signature"
  );

  // Second tick - the intent is now retired in the seen-set (invalid sig is
  // terminal), so it is short-circuited before verification: no re-verify and
  // no repeated warning (which would otherwise spam the log every poll).
  warnings.length = 0;
  await solver.tick();
  assert.equal(
    verifyCallCount,
    1,
    "should not verify again (intent retired after invalid signature)"
  );
  assert.equal(
    warnings.length,
    0,
    "should not re-warn for an already-rejected intent"
  );
});

test("verification cache evicts oldest entries when full", async () => {
  const smallCacheConfig: SolverConfig = {
    ...baseConfig,
    verificationCacheSize: 2, // Very small cache for testing
  };

  const intent1 = buildTestIntent();
  const intent2 = buildIntent({
    ...intent1,
    nonce: "999", // Different nonce = different hash
  });
  const intent3 = buildIntent({
    ...intent1,
    nonce: "888", // Another different hash
  });

  const record1 = buildTestRecord(intent1);
  const record2 = buildTestRecord(intent2);
  const record3 = buildTestRecord(intent3);

  let verifiedHashes: Hex[] = [];
  const mockVerify = mock.fn(async (intent: any) => {
    const hash = hashIntent(intent, domain);
    verifiedHashes.push(hash);
    return true;
  });

  const mockLogger: Logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  // A profitable fill would retire the intent into the seen-set, making it
  // un-re-pollable. This test only exercises the verification cache, so we
  // starve inventory: every intent is verified, then skipped non-terminally
  // ("insufficient inventory") and stays re-pollable across ticks.
  const zeroInventory: InventoryProvider = {
    availableBalance: async () => 0n,
  };

  const mockExecutor: Executor = {
    fill: async () => ({ settlementTx: "0xfilled" }),
  };

  // PerihelionClient captures globalThis.fetch at construction, so we install a
  // single mock (before constructing the solver) that returns whatever is in
  // `pendingRecords`, and swap that array between ticks to drive each poll.
  let pendingRecords: IntentRecord[] = [record1];
  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => pendingRecords,
  })) as any;

  const solver = new Solver(smallCacheConfig, mockExecutor, mockLogger, undefined, zeroInventory, mockVerify);

  // Process intent1 and intent2 (fills cache to capacity)
  pendingRecords = [record1];
  await solver.tick();

  pendingRecords = [record2];
  await solver.tick();

  assert.equal(verifiedHashes.length, 2, "should verify both intents");
  verifiedHashes = [];

  // Process intent3 (should evict intent1)
  pendingRecords = [record3];
  await solver.tick();

  assert.equal(verifiedHashes.length, 1, "should verify new intent3");
  verifiedHashes = [];

  // Process intent1 again (should re-verify since it was evicted)
  pendingRecords = [record1];
  await solver.tick();

  assert.equal(
    verifiedHashes.length,
    1,
    "should re-verify intent1 after eviction"
  );
  assert.equal(verifiedHashes[0], record1.hash, "re-verified intent1");

  // Re-adding intent1 filled the size-2 cache and evicted the current LRU entry
  // (intent2), leaving {intent3, intent1}. Re-processing intent3 should hit the
  // cache — proving the most-recently-used survivor was not re-verified.
  verifiedHashes = [];
  pendingRecords = [record3];
  await solver.tick();

  assert.equal(
    verifiedHashes.length,
    0,
    "intent3 should still be cached (not evicted)"
  );
});

// ─── Issue 92: FatalError propagation and graceful drain ────────────────────

test("FatalError thrown from tick() rejects start()", async () => {
  const fatal = new FatalError("permanent RPC failure");

  global.fetch = mock.fn(async () => { throw fatal; }) as any;

  const solver = new Solver(baseConfig, { fill: async () => ({ settlementTx: "0x" }) }, {
    info: () => {},
    warn: () => {},
    error: () => {},
  });

  const err = await solver.start().catch((e) => e);
  assert.strictEqual(err, fatal, "start() should reject with the FatalError instance");
});

test("recoverable tick error keeps loop alive, does not reject start()", async () => {
  let calls = 0;
  global.fetch = mock.fn(async () => {
    calls++;
    if (calls === 1) throw new Error("transient network blip");
    // Second call: return empty list so stop() resolves start()
    return { ok: true, status: 200, json: async () => [] };
  }) as any;

  const solver = new Solver(
    { ...baseConfig, pollIntervalMs: 0 },
    { fill: async () => ({ settlementTx: "0x" }) },
    { info: () => {}, warn: () => {}, error: () => {} },
  );

  const startP = solver.start();
  // Wait for second tick to complete
  await new Promise((r) => setTimeout(r, 30));
  solver.stop();
  await assert.doesNotReject(startP, "recoverable error must not reject start()");
  assert.ok(calls >= 2, "loop should have continued after recoverable error");
});

test("stop() interrupts inter-tick sleep so start() resolves promptly", async () => {
  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => [],
  })) as any;

  const solver = new Solver(
    { ...baseConfig, pollIntervalMs: 60_000 }, // would hang for 60 s without stop()
    { fill: async () => ({ settlementTx: "0x" }) },
    { info: () => {}, warn: () => {}, error: () => {} },
  );

  const startP = solver.start();
  await new Promise((r) => setTimeout(r, 20)); // let first tick complete
  solver.stop();

  const result = await Promise.race([
    startP.then(() => "resolved" as const),
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 1_000)),
  ]);
  assert.equal(result, "resolved", "start() should resolve promptly after stop(), not wait 60 s");
});

test("complete flow: hash validation and cached verification", async () => {
  const intent = buildTestIntent();
  const correctHash = hashIntent(intent, domain);
  const record: IntentRecord = {
    intent,
    signature: "0xdeadbeef" as Hex,
    hash: correctHash,
    status: "pending",
    createdAt: Math.floor(Date.now() / 1000),
  };

  let verifyCount = 0;
  const mockVerify = mock.fn(async () => {
    verifyCount++;
    return true;
  });

  const fills: Hex[] = [];
  const mockExecutor: Executor = {
    fill: async (signed) => {
      fills.push(signed.hash);
      return { settlementTx: "0xsettled" };
    },
  };

  const logs: Array<{ type: string; msg: string }> = [];
  const mockLogger: Logger = {
    info: (msg) => logs.push({ type: "info", msg }),
    warn: (msg) => logs.push({ type: "warn", msg }),
    error: (msg) => logs.push({ type: "error", msg }),
  };

  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => [record],
  })) as any;

  const solver = new Solver(baseConfig, mockExecutor, mockLogger, undefined, undefined, mockVerify);

  // First tick: verify and fill
  await solver.tick();
  assert.equal(verifyCount, 1, "should verify on first tick");
  assert.equal(fills.length, 1, "should fill the intent");
  assert.equal(fills[0], correctHash, "filled correct intent");

  // Second tick: use cached verification, but don't fill (seen)
  await solver.tick();
  assert.equal(verifyCount, 1, "should not re-verify (cached)");
  assert.equal(fills.length, 1, "should not fill again (already seen)");
});

// ─── Issue 314: in-flight inventory reservation ──────────────────────────────

test("consider: reserves inventory before filling, preventing a second intent from over-committing the same balance", async () => {
  const intentA = buildTestIntent();
  const intentB = buildIntent({ ...intentA, nonce: "555555" });
  const recordA = buildTestRecord(intentA);
  const recordB = buildTestRecord(intentB);

  // Balance covers exactly one intent's minDestAmount (990000), not both.
  const inventory: InventoryProvider = { availableBalance: async () => 990000n };

  let releaseFill: () => void = () => {};
  const fillGate = new Promise<void>((resolve) => {
    releaseFill = resolve;
  });

  const fillAttempts: string[] = [];
  const mockExecutor: Executor = {
    fill: async (signed) => {
      fillAttempts.push(signed.intent.nonce);
      await fillGate;
      return { settlementTx: "0xfilled" };
    },
  };

  const mockLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
  global.fetch = mock.fn(async () => ({ ok: true, status: 200, json: async () => [] })) as any;

  const solver = new Solver(baseConfig, mockExecutor, mockLogger, undefined, inventory, async () => true);
  const consider = (solver as unknown as { consider(record: IntentRecord): Promise<void> }).consider.bind(
    solver,
  );

  // Start filling intentA; its executor.fill() call blocks on fillGate,
  // holding the reservation open past the point evaluate() re-reads balance.
  const considerA = consider(recordA);

  // Let intentA's verify → evaluate → reserve → fill-start run to completion.
  // Everything up to that point is microtask-only (no real timers), so a
  // single macrotask boundary is enough to observe the fill call landing.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fillAttempts.length, 1, "intentA's fill should be in flight");

  // intentB needs the same asset and would fit alone, but not alongside
  // intentA's still-unsettled reservation.
  await consider(recordB);
  assert.equal(
    fillAttempts.length,
    1,
    "intentB should be skipped: the shared balance is already reserved by intentA",
  );

  releaseFill();
  await considerA;
  assert.equal(fillAttempts.length, 1, "no additional fill attempts after intentA settles");
});

test("consider: releases the reservation when a fill fails, freeing capacity for a later intent", async () => {
  const intentA = buildTestIntent();
  const intentB = buildIntent({ ...intentA, nonce: "777777" });
  const recordA = buildTestRecord(intentA);
  const recordB = buildTestRecord(intentB);

  const inventory: InventoryProvider = { availableBalance: async () => 990000n };

  const mockExecutor: Executor = {
    fill: mock.fn(async (signed) => {
      if (signed.intent.nonce === intentA.nonce) {
        throw new Error("simulated fill failure");
      }
      return { settlementTx: "0xfilled" };
    }),
  };

  const errors: string[] = [];
  const mockLogger: Logger = {
    info: () => {},
    warn: () => {},
    error: (msg) => errors.push(msg),
  };

  global.fetch = mock.fn(async () => ({ ok: true, status: 200, json: async () => [] })) as any;

  const solver = new Solver(baseConfig, mockExecutor, mockLogger, undefined, inventory, async () => true);
  const consider = (solver as unknown as { consider(record: IntentRecord): Promise<void> }).consider.bind(
    solver,
  );

  await consider(recordA);
  assert.ok(errors.some((e) => e.includes("fill failed")), "intentA's fill should have failed");

  // intentA's failed reservation must be released — intentB can still fill
  // against the same balance.
  await consider(recordB);
  assert.equal(
    (mockExecutor.fill as ReturnType<typeof mock.fn>).mock.callCount(),
    2,
    "intentB's fill should have been attempted after intentA's reservation was released",
  );
});
