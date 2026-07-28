/**
 * Profitability evaluation for the reference solver.
 *
 * Economic model
 * ──────────────
 * profit = proceeds - deliveryCost - fees - riskBuffer
 *
 *   proceeds      = sourceAmount converted to dest-asset units at the cross rate
 *   deliveryCost  = amount of destAsset the solver must actually deliver (≥ minDestAmount)
 *   fees          = source-leg gas + dest-leg (Stellar/LayerZero) fees, in dest-asset units
 *   riskBuffer    = configurable bps of capital deployed to cover FX/inventory risk
 *
 * All inputs are explicit and injectable so production operators can wire in
 * real oracles without touching the decision logic.
 *
 * Decimal normalization
 * ─────────────────────
 * Source and destination decimals are passed in as explicit parameters rather
 * than hard-coded. The canonical asset table and corridor conversion rule live
 * in docs/assets.md; any production corridor must supply decimals that match
 * that table.
 */

import { isExpired, fromSmallestUnits, toSmallestUnits } from "@perihelion/sdk";
import type { Intent } from "@perihelion/sdk";
import { zeroAddress, isAddressEqual, type Address } from "viem";
import type { SolverConfig } from "./config.js";
import type { InventoryProvider, InFlightTracker } from "./inventory.js";
import { UnlimitedInventoryProvider } from "./inventory.js";

// ─── injectable interfaces ───────────────────────────────────────────────────

/**
 * Returns the number of decimal places for the given asset identifier.
 * `assetId` is a Stellar asset string ("USDC:GA5Z...") or EVM token address.
 */
export type DecimalsLookup = (assetId: string) => number | Promise<number>;

/**
 * Returns the exchange rate: how many dest-asset human units equal one
 * source-asset human unit. E.g. for USDC→USDC on a 1:1 corridor: 1.0.
 */
export type PriceOracle = (sourceAsset: string, destAsset: string) => Promise<number>;

/**
 * Returns the total fee cost expressed in dest-asset smallest units, covering
 * both the source-chain gas leg and the dest-chain (Stellar + LayerZero) leg.
 */
export type FeeEstimator = (intent: Intent) => Promise<bigint>;

// ─── defaults ────────────────────────────────────────────────────────────────

/**
 * Known decimal configurations for common assets. Keep this aligned with
 * docs/assets.md, or replace it with a live lookup in production.
 */
const KNOWN_DECIMALS: Record<string, number> = {
  // Stellar (7dp)
  "native": 7,
  // EVM stablecoins (6dp) — matched by lower-cased address prefix check below
};

/** Fallback decimal lookup: known table → 7dp for Stellar assets → error. */
export const defaultDecimalsLookup: DecimalsLookup = (assetId: string): number => {
  if (KNOWN_DECIMALS[assetId] !== undefined) return KNOWN_DECIMALS[assetId];
  // Stellar issued asset: "CODE:ISSUER" uses 7dp.
  if (assetId.includes(":")) return 7;
  // EVM token address (0x...): 6dp is the stablecoin convention on the
  // documented corridor. Operators must supply a DecimalsLookup for 18dp tokens.
  if (assetId.startsWith("0x")) return 6;
  throw new Error(
    `[Perihelion] decimals not configured for asset "${assetId}". ` +
    `Provide a DecimalsLookup that returns the correct precision.`,
  );
};

/** 1:1 stub oracle — suitable only for same-value stablecoin corridors. */
export const defaultPriceOracle: PriceOracle = async () => 1.0;

/** Zero-fee stub — operators must replace with real gas/LayerZero estimates. */
export const defaultFeeEstimator: FeeEstimator = async () => 0n;

// ─── core pricing function ───────────────────────────────────────────────────

export interface PricingDeps {
  decimalsLookup?: DecimalsLookup;
  priceOracle?: PriceOracle;
  feeEstimator?: FeeEstimator;
}

/**
 * Compute the solver's proceeds from an intent in dest-asset smallest units.
 * proceeds = sourceAmount × rate, with decimal normalization applied.
 */
export async function computeProceeds(
  intent: Intent,
  deps: PricingDeps = {},
): Promise<bigint> {
  const decimals = deps.decimalsLookup ?? defaultDecimalsLookup;
  const oracle = deps.priceOracle ?? defaultPriceOracle;

  const srcDecimals = await decimals(intent.sourceAsset);
  const dstDecimals = await decimals(intent.destAsset);
  const rate = await oracle(intent.sourceAsset, intent.destAsset);

  if (rate <= 0) throw new Error("[Perihelion] price oracle returned non-positive rate");

  // Convert source amount to human units, apply rate, convert to dest units.
  const humanSrc = fromSmallestUnits(intent.sourceAmount, srcDecimals);
  const humanDst = (parseFloat(humanSrc) * rate).toFixed(dstDecimals);
  return BigInt(toSmallestUnits(humanDst, dstDecimals));
}

// ─── decision types ──────────────────────────────────────────────────────────

export interface FillDecision {
  readonly fill: boolean;
  readonly reason: string;
  /**
   * True when the skip reason is durable (intent will never become profitable
   * or fillable). False indicates a transient condition worth retrying.
   */
  readonly terminal: boolean;
  /** Estimated profit in basis points of capital deployed, when computed. */
  readonly profitBps?: number;
}

// ─── evaluate ────────────────────────────────────────────────────────────────

/**
 * Decide whether to fill an intent.
 *
 * profit_bps = (proceeds - deliveryCost - fees) * 10_000 / proceeds
 * where deliveryCost = minDestAmount (solver must deliver at least this).
 */
/**
 * Returns true when the intent is open to any solver or is reserved for
 * `solverAddress`. Uses viem helpers for checksum-insensitive comparison.
 */
export function isSolverEligible(
  preferredSolver: string,
  solverAddress: Address,
): boolean {
  const preferred = preferredSolver as Address;
  return (
    isAddressEqual(preferred, zeroAddress) ||
    isAddressEqual(preferred, solverAddress)
  );
}

/**
 * Third argument to {@link evaluate}: an optional bag of injectable pricing
 * dependencies that may also double as the inventory provider. Callers can pass
 * pricing overrides (`priceOracle`/`feeEstimator`/`decimalsLookup`), an
 * inventory provider (`availableBalance`), or an object satisfying both.
 */
export type EvaluateDeps = PricingDeps & Partial<InventoryProvider>;

/** Decide whether to fill an intent given current config and pricing. */
export async function evaluate(
  intent: Intent,
  config: SolverConfig,
  deps: EvaluateDeps = {},
  inFlight?: InFlightTracker,
): Promise<FillDecision> {
  // ── terminal checks ──────────────────────────────────────────────────────
  if (isExpired(intent)) {
    return { fill: false, reason: "intent expired", terminal: true };
  }
  if (!config.supportedDestAssets.includes(intent.destAsset)) {
    return { fill: false, reason: `unsupported dest asset ${intent.destAsset}`, terminal: true };
  }
  if (!isSolverEligible(intent.preferredSolver, config.solverAddress)) {
    return { fill: false, reason: "reserved for another solver", terminal: true };
  }

  // ── pricing (transient failures → non-terminal skip so we retry later) ────
  let proceeds: bigint;
  let fees: bigint;
  try {
    proceeds = await computeProceeds(intent, deps);
    fees = await (deps.feeEstimator ?? defaultFeeEstimator)(intent);
  } catch (err) {
    return { fill: false, reason: `pricing error: ${String(err)}`, terminal: false };
  }

  // The solver must deliver at least minDestAmount of the dest asset.
  const minOut = BigInt(intent.minDestAmount);
  if (proceeds < minOut) {
    return { fill: false, reason: "cannot meet minDestAmount", terminal: false };
  }

  // ── profit check ─────────────────────────────────────────────────────────
  // profit = proceeds - deliveryCost - fees, where deliveryCost = minDestAmount
  // profitBps = profit * 10_000 / proceeds
  const profit = proceeds - minOut - fees;
  if (profit <= 0n) {
    return { fill: false, reason: "fee-inclusive profit is non-positive", terminal: false };
  }
  const profitBps = Number((profit * 10_000n) / proceeds);

  // ── inventory check ───────────────────────────────────────────────────────
  // Use the caller-supplied provider if it exposes a balance, else unlimited.
  const inventory: InventoryProvider =
    typeof deps.availableBalance === "function"
      ? (deps as InventoryProvider)
      : new UnlimitedInventoryProvider();
  const required = minOut;
  const available = await inventory.availableBalance(intent.destAsset);
  const reserved = inFlight?.reservedFor(intent.destAsset) ?? 0n;
  if (available - reserved < required) {
    return { fill: false, reason: "insufficient inventory", terminal: false };
  }

  return { fill: true, reason: "profitable", terminal: false, profitBps };
}
