import type { Hex } from "@perihelion/sdk";
import type { IntentStatus, MempoolIntentRecord } from "./types.js";

/** Hard cap on stored intents, preventing unbounded memory growth. */
const MAX_RECORDS = 10_000;

export class IntentStore {
  private records = new Map<Hex, MempoolIntentRecord>();

  set(hash: Hex, record: MempoolIntentRecord): void {
    this.evictExpired();
    if (this.records.size >= MAX_RECORDS && !this.records.has(hash)) {
      throw new Error("Mempool is at capacity");
    }
    this.records.set(hash, record);
  }

  /** Drop pending records whose deadline has passed, freeing capacity. */
  private evictExpired(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [hash, record] of this.records) {
      if (record.status === "pending" && record.intent.deadline <= now) {
        this.records.delete(hash);
      }
    }
  }

  get(hash: Hex): MempoolIntentRecord | undefined {
    return this.records.get(hash);
  }

  updateStatus(hash: Hex, status: IntentStatus): boolean {
    const record = this.records.get(hash);
    if (!record) return false;
    record.status = status;
    return true;
  }

  all(): MempoolIntentRecord[] {
    return Array.from(this.records.values());
  }
}
