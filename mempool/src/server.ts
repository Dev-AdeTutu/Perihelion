import express, { type Request, Response, NextFunction } from "express";
import type { Server } from "node:http";
import { hashIntent, verifyIntent, perihelionDomain, parseIntent, isExpired } from "@perihelion/sdk";
import type { Hex, SignedIntent, Address } from "@perihelion/sdk";
import { IntentStore } from "./store.js";
import type { MempoolIntentRecord, IntentStatus } from "./types.js";

const SIGNATURE_RE = /^0x[0-9a-fA-F]+$/;
/** Per-IP submission budget for POST /intents. */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 60;

export interface MempoolServerOptions {
  port?: number;
  host?: string;
  /** EVM chain ID the escrow is deployed on. Binds the EIP-712 domain. */
  chainId?: number;
  /** PerihelionEscrow contract address. Binds the EIP-712 domain. */
  verifyingContract?: Address;
}

export class MempoolServer {
  private app = express();
  private store = new IntentStore();
  private port: number;
  private host: string;
  private domain: ReturnType<typeof perihelionDomain>;
  private server?: Server;
  private rateLimitHits = new Map<string, number[]>();

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
    this.app.use(express.json({ limit: "8kb" }));

    this.app.post("/intents", this.rateLimit.bind(this), this.handleSubmitIntent.bind(this));
    this.app.get("/intents/:hash", this.handleGetIntent.bind(this));
    this.app.get("/intents", this.handleListIntents.bind(this));
  }

  /** Rejects an IP once it exceeds a fixed request budget within a sliding window. */
  private rateLimit(req: Request, res: Response, next: NextFunction): void {
    const ip = req.ip ?? "unknown";
    const now = Date.now();
    const recent = (this.rateLimitHits.get(ip) ?? []).filter(
      (t) => now - t < RATE_LIMIT_WINDOW_MS,
    );

    if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
      res.status(429).json({ error: "Too many requests" });
      return;
    }

    recent.push(now);
    this.rateLimitHits.set(ip, recent);
    next();
  }

  private async handleSubmitIntent(req: Request, res: Response): Promise<void> {
    try {
      const signed = req.body as SignedIntent;

      if (!signed.intent || !signed.signature || !SIGNATURE_RE.test(signed.signature)) {
        res.status(400).json({ error: "Missing or malformed intent or signature" });
        return;
      }

      // Cheap structural validation before the costly signature recovery below.
      let intent: SignedIntent["intent"];
      try {
        intent = parseIntent(signed.intent);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : "Invalid intent" });
        return;
      }

      if (isExpired(intent)) {
        res.status(400).json({ error: "Intent already expired" });
        return;
      }

      // Verify EIP-712 signature
      const isValid = await verifyIntent(intent, signed.signature, this.domain);
      if (!isValid) {
        res.status(400).json({ error: "Invalid signature" });
        return;
      }

      const hash = hashIntent(intent, this.domain);
      const record: MempoolIntentRecord = {
        hash,
        intent,
        signature: signed.signature,
        status: "pending",
        createdAt: Date.now(),
      };

      this.store.set(hash, record);
      res.json({ hash });
    } catch (err) {
      console.error("[mempool] submitIntent failed:", err);
      res.status(500).json({ error: "Internal server error" });
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
    const { status } = req.query as { status?: IntentStatus };

    let records = this.store.all();
    if (status) {
      records = records.filter((r) => r.status === status);
    }

    res.json(records);
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, this.host, () => {
        console.log(`Mempool server listening on http://${this.host}:${this.port}`);
        resolve();
      });
    });
  }

  /** Stop the HTTP listener. Resolves once the server has closed. */
  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
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
