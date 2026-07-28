import type { Hex } from "@perihelion/sdk";
import type { IntentStatus, MempoolIntentRecord } from "./types.js";

/** Terminal statuses cannot transition to any other status. */
const TERMINAL_STATUSES: ReadonlySet<IntentStatus> = new Set(["settled", "refunded", "expired"]);

export class IntentStore {
  private records = new Map<Hex, MempoolIntentRecord>();

  set(hash: Hex, record: MempoolIntentRecord): void {
    this.records.set(hash, record);
  }

  get(hash: Hex): MempoolIntentRecord | undefined {
    return this.records.get(hash);
  }

  /**
   * Update a record's status. Refuses to move a record out of a terminal
   * status (`settled`/`refunded`/`expired`) — those are final.
   */
  updateStatus(hash: Hex, status: IntentStatus): boolean {
    const record = this.records.get(hash);
    if (!record) return false;
    if (TERMINAL_STATUSES.has(record.status)) return false;
    record.status = status;
    return true;
  }

  all(): MempoolIntentRecord[] {
    return Array.from(this.records.values());
  }
}
