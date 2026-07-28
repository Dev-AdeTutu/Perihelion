import express, { type Request, Response } from "express";
import type { Server } from "node:http";
import { hashIntent, verifyIntent, perihelionDomain } from "@perihelion/sdk";
import type { Hex, SignedIntent, Address } from "@perihelion/sdk";
import { IntentStore } from "./store.js";
import type { MempoolIntentRecord, IntentStatus } from "./types.js";

export interface MempoolServerOptions {
  port?: number;
  host?: string;
  /** EVM chain ID the escrow is deployed on. Binds the EIP-712 domain. */
  chainId?: number;
  /** PerihelionEscrow contract address. Binds the EIP-712 domain. */
  verifyingContract?: Address;
}

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;
const SWEEP_INTERVAL_MS = 30_000;

export class MempoolServer {
  private app = express();
  private store = new IntentStore();
  private port: number;
  private host: string;
  private domain: ReturnType<typeof perihelionDomain>;
  private server?: Server;
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(opts: MempoolServerOptions = {}) {
    this.port = opts.port ?? 3000;
    this.host = opts.host ?? "localhost";
    this.domain = perihelionDomain(
      opts.chainId ?? 8453,
      opts.verifyingContract ?? "0x0000000000000000000000000000000000000000",
    );
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.use(express.json());

    this.app.post("/intents", this.handleSubmitIntent.bind(this));
    this.app.get("/intents/:hash", this.handleGetIntent.bind(this));
    this.app.get("/intents", this.handleListIntents.bind(this));
  }

  private async handleSubmitIntent(req: Request, res: Response): Promise<void> {
    try {
      const signed = req.body as SignedIntent;

      if (!signed.intent || !signed.signature) {
        res.status(400).json({ error: "Missing intent or signature" });
        return;
      }

      // Verify EIP-712 signature
      const isValid = await verifyIntent(signed.intent, signed.signature, this.domain);
      if (!isValid) {
        res.status(400).json({ error: "Invalid signature" });
        return;
      }

      const hash = hashIntent(signed.intent, this.domain);
      const record: MempoolIntentRecord = {
        hash,
        intent: signed.intent,
        signature: signed.signature,
        status: "pending",
        submittedAt: Date.now(),
      };

      this.store.set(hash, record);
      res.json({ hash });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  }

  private handleGetIntent(req: Request, res: Response): void {
    const { hash } = req.params as { hash: Hex };
    const record = this.store.get(hash as Hex);

    if (!record) {
      res.status(404).json({ error: "Intent not found" });
      return;
    }

    res.json(record);
  }

  private handleListIntents(req: Request, res: Response): void {
    const { status, cursor } = req.query as { status?: IntentStatus; cursor?: string };
    const limitParam = Number(req.query.limit);
    const limit = Number.isInteger(limitParam) && limitParam > 0
      ? Math.min(limitParam, MAX_LIST_LIMIT)
      : DEFAULT_LIST_LIMIT;

    const records = this.store.all(status);
    const startIndex = cursor ? records.findIndex((r) => r.hash === cursor) + 1 : 0;
    const page = records.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < records.length ? page[page.length - 1]?.hash : undefined;

    res.json({ records: page, nextCursor });
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      console.warn(
        "Mempool store is in-memory only: pending intents are lost on restart.",
      );
      this.sweepTimer = setInterval(() => this.store.evictExpired(), SWEEP_INTERVAL_MS);
      this.sweepTimer.unref?.();
      this.server = this.app.listen(this.port, this.host, () => {
        console.log(`Mempool server listening on http://${this.host}:${this.port}`);
        resolve();
      });
    });
  }

  /** Stop the HTTP listener. Resolves once the server has closed. */
  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.sweepTimer) {
        clearInterval(this.sweepTimer);
        this.sweepTimer = undefined;
      }
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => (err ? reject(err) : resolve()));
      this.server = undefined;
    });
  }

  updateStatus(hash: Hex, status: IntentStatus): boolean {
    return this.store.updateStatus(hash, status);
  }
}
