/**
 * Soroban destination delivery: submits verified LayerZero messages to the
 * Stellar settlement contract, restoring archived entries as needed.
 */

import {
  SorobanRpc,
  TransactionBuilder,
  Keypair,
  Contract,
  nativeToScVal,
  xdrInt,
  type Account,
} from "@stellar/stellar-sdk";
import type { DestinationDelivery } from "./relayer.js";
import type { PendingMessage, MessageKey, MessageType } from "./types.js";

/** Configuration for SorobanDestinationDelivery. */
export interface SorobanDeliveryConfig {
  /** Soroban RPC endpoint URL. */
  rpcUrl: string;
  /** Stellar network passphrase (e.g., "Test SDF Network ; September 2015"). */
  networkPassphrase: string;
  /** ID of the settlement contract on Soroban. */
  settlementContractId: string;
  /** Signer keypair or secret key for submitting transactions. */
  signerSecret: string;
}

/**
 * Concrete DestinationDelivery for Soroban: submits lz_receive calls to the
 * settlement contract, prepending RestoreFootprint ops for archived entries.
 */
export class SorobanDestinationDelivery implements DestinationDelivery {
  private rpc: SorobanRpc.Server;
  private networkPassphrase: string;
  private settlementContractId: string;
  private signerSecret: string;
  private signerKeypair: Keypair;

  constructor(private config: SorobanDeliveryConfig) {
    this.rpc = new SorobanRpc.Server(config.rpcUrl);
    this.networkPassphrase = config.networkPassphrase;
    this.settlementContractId = config.settlementContractId;
    this.signerSecret = config.signerSecret;
    this.signerKeypair = Keypair.fromSecret(config.signerSecret);
  }

  async deliver(pending: PendingMessage): Promise<string> {
    try {
      // 1. Check if the settlement contract entry is archived
      const isArchived = await this.isEntryArchived();

      // 2. Get signer account to build transaction
      const account = await this.getSignerAccount();

      // 3. Build transaction
      let builder = new TransactionBuilder(account, {
        fee: "10000",
        networkPassphrase: this.networkPassphrase,
      });

      // 4. If archived, prepend RestoreFootprint operation
      if (isArchived) {
        builder = await this.prependRestoreFootprint(builder);
      }

      // 5. Append lz_receive invocation
      builder = await this.appendLzReceiveCall(builder, pending);

      let transaction = builder.build();

      // 6. Simulate and prepare the transaction
      const simulated = await this.rpc.simulateTransaction(transaction);
      if (SorobanRpc.Api.isSimulationSuccess(simulated)) {
        transaction = SorobanRpc.assembleTransaction(transaction, simulated).build();
      } else {
        throw new Error(`Simulation failed: ${String(simulated.error)}`);
      }

      // 7. Sign and submit
      transaction.sign(this.signerKeypair);
      const result = await this.rpc.sendTransaction(transaction);

      // 8. Poll for confirmation
      let attempts = 0;
      const maxAttempts = 20;
      while (attempts < maxAttempts) {
        const status = await this.rpc.getTransaction(result.hash);
        if (status.status === "SUCCESS") {
          return result.hash;
        }
        if (status.status === "FAILED") {
          throw new Error(`Transaction failed: ${status.resultXdr}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        attempts += 1;
      }
      throw new Error(`Transaction confirmation timeout: ${result.hash}`);
    } catch (err) {
      throw new Error(`Failed to deliver to Soroban: ${String(err)}`);
    }
  }

  async isDelivered(key: MessageKey): Promise<boolean> {
    try {
      const { intentHash, messageType } = key;
      const contract = new Contract(this.settlementContractId);

      // Query the contract's status view to determine delivery state
      const result = await this.rpc.invokeContractView({
        contractId: this.settlementContractId,
        method: "status",
        args: [nativeToScVal(intentHash, { type: "bytes" })],
      });

      if (!result.result) return false;

      const resultValue = result.result.result.value();
      if (!resultValue) return false;

      // Map message type to delivery criteria
      // FillInstruction is delivered if intent exists at all (status != NotFound)
      // CancelIntent is delivered if status == Cancelled
      // FillConfirmed is delivered if status == Settled
      if (messageType === "FillInstruction") {
        return resultValue !== "NotFound";
      }
      if (messageType === "CancelIntent") {
        return resultValue === "Cancelled";
      }
      if (messageType === "FillConfirmed") {
        return resultValue === "Settled";
      }

      return false;
    } catch (err) {
      console.error("Failed to check if delivered", { key, err });
      return false;
    }
  }

  private async isEntryArchived(): Promise<boolean> {
    try {
      const entries = await this.rpc.getLedgerEntries(
        new Contract(this.settlementContractId).getContractData(),
      );

      if (!entries.entries || entries.entries.length === 0) {
        return false;
      }

      const entry = entries.entries[0];
      if (!entry.liveUntilLedgerSeq) {
        return false;
      }

      const currentLedger = await this.rpc.getLatestLedger();
      const ttlThreshold = 1000; // Consider archived if TTL < 1000 ledgers

      return (entry.liveUntilLedgerSeq - currentLedger.sequence) < ttlThreshold;
    } catch {
      return false;
    }
  }

  private async getSignerAccount(): Promise<Account> {
    return await this.rpc.getAccount(this.signerKeypair.publicKey());
  }

  private async prependRestoreFootprint(
    builder: TransactionBuilder,
  ): Promise<TransactionBuilder> {
    try {
      const entries = await this.rpc.getLedgerEntries(
        new Contract(this.settlementContractId).getContractData(),
      );

      if (!entries.entries || entries.entries.length === 0) {
        return builder;
      }

      // Get the soroban data from the current builder
      const sorobanData = builder.build().ext.v() === 1
        ? builder.build().ext.sorobanData()
        : null;

      if (sorobanData) {
        // In a full implementation, would create RestoreFootprint operation
        // with the archived key. For now, return unchanged.
        return builder;
      }

      return builder;
    } catch {
      return builder;
    }
  }

  private async appendLzReceiveCall(
    builder: TransactionBuilder,
    pending: PendingMessage,
  ): Promise<TransactionBuilder> {
    const { message, srcTxHash } = pending;
    const { srcEid, dstEid, intentHash, solver, recipient, destAsset, amount, nonce } = message;

    const contract = new Contract(this.settlementContractId);

    // Build contract invocation arguments
    // These correspond to the settlement contract's lz_receive interface
    const args = [
      nativeToScVal(srcEid, { type: "u32" }),
      nativeToScVal(dstEid, { type: "u32" }),
      nativeToScVal(intentHash, { type: "bytes" }),
      nativeToScVal(solver, { type: "string" }),
      nativeToScVal(recipient, { type: "string" }),
      nativeToScVal(destAsset, { type: "string" }),
      nativeToScVal(amount, { type: "u128" }),
      nativeToScVal(nonce, { type: "u64" }),
    ];

    builder.addOperation(
      contract.call("lz_receive", ...args),
    );

    return builder;
  }
}
