import express, { type Request, Response } from "express";
import type { Server } from "node:http";
import { hashIntent, verifyIntent, perihelionDomain } from "@perihelion/sdk";
import type { Hex, SignedIntent, Address } from "@perihelion/sdk";
import { IntentStore } from "./store.js";
import type { MempoolIntentRecord, IntentStatus } from "./types.js";

const VALID_STATUSES: ReadonlySet<IntentStatus> = new Set([
  "pending",
  "settled",
  "refunded",
  "expired",
]);

export interface MempoolServerOptions {
  port?: number;
  host?: string;
  /** EVM chain ID the escrow is deployed on. Binds the EIP-712 domain. */
  chainId?: number;
  /** PerihelionEscrow contract address. Binds the EIP-712 domain. */
  verifyingContract?: Address;
  /**
   * Shared bearer token required on `PATCH /intents/:hash/status`. Only
   * holders of this token (the relayer/solver) may report status changes.
   * If omitted, the endpoint is unauthenticated — fine for local dev/tests,
   * unsafe to expose publicly.
   */
  statusToken?: string;
}

export class MempoolServer {
  private app = express();
  private store = new IntentStore();
  private port: number;
  private host: string;
  private domain: ReturnType<typeof perihelionDomain>;
  private server?: Server;
  private statusToken?: string;

  constructor(opts: MempoolServerOptions = {}) {
    this.port = opts.port ?? 3000;
    this.host = opts.host ?? "localhost";
    this.domain = perihelionDomain(
      opts.chainId ?? 8453,
      opts.verifyingContract ?? "0x0000000000000000000000000000000000000000",
    );
    this.statusToken = opts.statusToken;
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.use(express.json());

    this.app.post("/intents", this.handleSubmitIntent.bind(this));
    this.app.get("/intents/:hash", this.handleGetIntent.bind(this));
    this.app.get("/intents", this.handleListIntents.bind(this));
    this.app.patch("/intents/:hash/status", this.handleUpdateStatus.bind(this));
  }

  private handleUpdateStatus(req: Request, res: Response): void {
    if (this.statusToken) {
      const auth = req.header("authorization");
      if (auth !== `Bearer ${this.statusToken}`) {
        res.status(401).json({ error: "Missing or invalid status token" });
        return;
      }
    }

    const { hash } = req.params as { hash: Hex };
    const { status } = req.body as { status?: IntentStatus };

    if (!status || !VALID_STATUSES.has(status)) {
      res.status(400).json({ error: `status must be one of ${[...VALID_STATUSES].join(", ")}` });
      return;
    }

    if (!this.store.get(hash as Hex)) {
      res.status(404).json({ error: "Intent not found" });
      return;
    }

    const updated = this.store.updateStatus(hash as Hex, status);
    if (!updated) {
      res.status(409).json({ error: "Cannot change status of a terminal intent" });
      return;
    }

    res.json(this.store.get(hash as Hex));
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
        createdAt: Date.now(),
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
    const { status } = req.query as { status?: IntentStatus };

    let records = this.store.all();
    if (status) {
      records = records.filter((r) => r.status === status);
    }

    res.json(records);
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.statusToken) {
        console.warn(
          "PATCH /intents/:hash/status is unauthenticated (no statusToken configured) — do not expose this port publicly.",
        );
      }
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
