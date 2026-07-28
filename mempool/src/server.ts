import express, { type Request, Response } from "express";
import type { Server } from "node:http";
import { hashIntent, verifyIntent, perihelionDomain } from "@perihelion/sdk";
import type { Hex, SignedIntent, Address } from "@perihelion/sdk";
import { IntentStore } from "./store.js";
import type { MempoolIntentRecord, IntentStatus } from "./types.js";

export interface MempoolServerOptions {
  port?: number;
  host?: string;
  /** EVM chain ID the escrow is deployed on. Binds the EIP-712 domain. Required. */
  chainId: number;
  /** PerihelionEscrow contract address. Binds the EIP-712 domain. Required. */
  verifyingContract: Address;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export class MempoolServer {
  private app = express();
  private store = new IntentStore();
  private port: number;
  private host: string;
  private domain: ReturnType<typeof perihelionDomain>;
  private server?: Server;

  constructor(opts: MempoolServerOptions) {
    if (opts.chainId === undefined || opts.chainId === null || Number.isNaN(opts.chainId)) {
      throw new Error("MempoolServer requires a chainId — omitting it defaults signature verification to no real domain.");
    }
    if (!opts.verifyingContract || opts.verifyingContract.toLowerCase() === ZERO_ADDRESS) {
      throw new Error(
        "MempoolServer requires a non-zero verifyingContract (escrow address) — the zero address verifies against no deployed contract.",
      );
    }
    this.port = opts.port ?? 3000;
    this.host = opts.host ?? "localhost";
    this.domain = perihelionDomain(opts.chainId, opts.verifyingContract);
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.use(express.json());

    this.app.get("/info", this.handleInfo.bind(this));
    this.app.post("/intents", this.handleSubmitIntent.bind(this));
    this.app.get("/intents/:hash", this.handleGetIntent.bind(this));
    this.app.get("/intents", this.handleListIntents.bind(this));
  }

  private handleInfo(_req: Request, res: Response): void {
    res.json({ chainId: this.domain.chainId, verifyingContract: this.domain.verifyingContract });
  }

  private async handleSubmitIntent(req: Request, res: Response): Promise<void> {
    try {
      const signed = req.body as SignedIntent;

      if (!signed.intent || !signed.signature) {
        res.status(400).json({ error: "Missing intent or signature" });
        return;
      }

      if (signed.intent.sourceChainId !== this.domain.chainId) {
        res.status(400).json({
          error: `Chain ID mismatch: intent is for chain ${signed.intent.sourceChainId}, mempool is configured for chain ${this.domain.chainId}`,
        });
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
        console.log(
          `Mempool server listening on http://${this.host}:${this.port} ` +
            `(chainId=${this.domain.chainId}, escrow=${this.domain.verifyingContract})`,
        );
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
