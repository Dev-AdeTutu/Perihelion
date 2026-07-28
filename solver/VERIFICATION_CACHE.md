# Signature Verification Caching Implementation

## Overview

This document describes the signature verification caching and hash validation implementation added to the Perihelion solver to address performance and security concerns.

## Problem Statement

The solver previously called `verifyIntent(intent, signature)` (an ECDSA recovery operation via viem) for each intent on every consideration. This had two issues:

1. **Performance**: ECDSA recovery is computationally expensive. When intents are reconsidered (after retry/reconsideration logic), the same signature would be re-verified repeatedly at the poll rate, wasting CPU.

2. **Security**: The solver trusted the mempool's association of intent↔signature↔hash without independently verifying that the record's hash field matched the recomputed hash, creating a mempool-trust gap.

A follow-up issue (#350) identified two further problems with the original caching design:

3. **Cache key too coarse**: The cache was keyed on the intent hash alone. Two submissions of the same intent hash carrying *different* signatures (e.g. an attacker-forged signature followed by the user's real, corrected signature) shared a single cache entry, so whichever signature was verified first "poisoned" the result for every later resubmission of that hash — and the domain (chain ID / verifying contract) played no role in the key at all.

4. **Negative results cached forever, and treated as terminal**: An invalid verification result was cached indefinitely and the intent hash was added to the permanent `seen` set (`"Terminal: invalid signature will never become valid"`). That comment conflates the signature with the hash: the *signature* being invalid is indeed permanent, but the *intent hash* can be resubmitted later with a corrected signature. Because the old code retired the hash into `seen` on the first invalid signature, a corrected resubmission of the same intent was silently dropped forever — the solver would never re-verify or fill it.

## Solution

### 1. Verification Result Caching, Keyed on Domain + Hash + Signature

`VerificationCache` stores verification results keyed by a composite string built from:

- the EIP-712 domain (`chainId` + `verifyingContract`),
- the intent hash, and
- the signature bytes.

See `verificationCacheKey()` in `solver/src/solver.ts`. This means:

- Two submissions of the same intent hash with **different signatures** never share a cache entry — each is independently verified.
- A signature that is valid under one chain/escrow domain is never conflated with a (hypothetically identical) signature under a different domain.

### 2. TTL on Negative Results Only

- **Positive results** (`valid === true`) are cached with **no TTL** — a valid EIP-712 signature over a given domain+hash never becomes invalid, so these entries are bounded only by LRU eviction.
- **Negative results** (`valid === false`) are cached for a short TTL (`NEGATIVE_VERIFICATION_TTL_MS`, currently 60 seconds). Once a negative entry expires, the next `get()` treats it as a miss, and the (domain, hash, signature) triple is re-verified on next consideration.

The TTL prevents a negative result from suppressing verification indefinitely, while still avoiding redundant ECDSA recovery for a signature that is being resubmitted unchanged every poll interval.

### 3. Invalid Signature Is Not Terminal for the Intent Hash

`consider()` no longer adds the hash to the `seen` set when the signature fails verification. `seen` is reserved for genuinely terminal outcomes: a successful fill, or exhausted fill retries. This means:

- A corrected resubmission of a previously-invalid intent — same hash, valid signature — is reconsidered on the very next poll (it isn't blocked by `seen`) and, once verified, proceeds to evaluation and fill like any other intent.
- Repeated resubmission of the *same* invalid (hash, signature) pair is still bounded: the negative verification-cache entry (TTL above) avoids re-running ECDSA recovery on every poll, while still logging a rejection warning each time (since the hash isn't in `seen`, we don't want to blind ourselves to persistent bad-signature traffic).

### 4. Hash Validation

Before signature verification, the solver still:

1. Recomputes the intent hash using `hashIntent(intent, domain)`
2. Compares it against the mempool's returned hash
3. Rejects the intent if there's a mismatch
4. Only proceeds to signature verification if hashes match

This closes the mempool-trust gap and catches hash/intent mismatches early. (Unchanged by #350.)

## Implementation Details

### Modified Files

1. **`solver/src/solver.ts`**
   - `VerificationCache` is now keyed by `verificationCacheKey(domain, hash, signature)` instead of the raw hash.
   - Negative cache entries carry an `expiresAt` timestamp (`Date.now() + NEGATIVE_VERIFICATION_TTL_MS`); positive entries have none.
   - `consider()` no longer calls `this.seen.add(hash, deadlineMs)` when the signature is invalid — only on a successful fill or after exhausting fill retries.
   - Updated the stale `seen` doc comment and the "Terminal: invalid signature will never become valid" comment, which described the hash rather than the (hash, signature) pair.

2. **`solver/test/solver.test.ts`**
   - Updated "caches invalid signatures" test to assert the rejection is still logged every poll (since the hash is not retired) while ECDSA re-verification is still skipped within the negative TTL.
   - Added: corrected resubmission (same hash, valid signature, after a prior invalid one) is verified and filled.
   - Added: negative cache entries expire, triggering re-verification.
   - Added: two different signatures over the same hash are verified independently (no shared cache entry).

No configuration changes were required — `verificationCacheSize` (from `solver/src/config.ts`) still bounds the cache's LRU capacity exactly as before; the negative TTL is a fixed code constant (`NEGATIVE_VERIFICATION_TTL_MS`) rather than a configurable value, since 60s is short enough not to need per-operator tuning.

## Verification Flow

```
Intent received from mempool
    │
    ├─► Recompute hash using hashIntent()
    │
    ├─► Compare with mempool's hash
    │   └─► Mismatch? → Reject with warning
    │
    ├─► Check verification cache by (domain, hash, signature)
    │   ├─► Cached valid (no TTL)? → Skip verification
    │   ├─► Cached invalid (within TTL)? → Reject with warning, do not re-verify
    │   ├─► Cached invalid (TTL expired)? → Treat as miss, re-verify
    │   └─► Not cached? → Verify and cache result
    │
    ├─► Invalid? → Log warning, do NOT add hash to `seen` (not terminal), return
    │
    └─► Valid → Proceed with profitability evaluation
        └─► Filled or retries exhausted → add hash to `seen` (terminal)
```

## Performance Impact

- **Best case** (cached, positive or within negative TTL): O(1) lookup instead of ECDSA recovery.
- **Worst case** (cache miss, including expired negative entries): same as before + O(1) cache insertion.
- **Memory**: O(n) where n = min(unique (domain, hash, signature) triples seen, cache size limit). Each key additionally encodes the signature, so memory per entry is somewhat larger than the old hash-only key, but the LRU cap still bounds total memory.

## Testing

Run tests:
```bash
npm test -w solver
```

Key scenarios covered in `solver/test/solver.test.ts`:

1. Verification only occurs once per unique (domain, hash, signature) triple.
2. Hash mismatch detected and rejected.
3. Invalid signature results are cached (with a TTL) to avoid redundant re-verification.
4. Negative cache entries expire and are re-verified.
5. A corrected resubmission (same hash, valid signature) after a prior invalid submission is verified and filled — not silently dropped.
6. Two different signatures over the same intent hash are verified independently.
7. LRU eviction works correctly at capacity.

## Migration Notes

No new required environment variables were introduced by #350. Existing operators do not need to change their `.env` files or `PERIHELION_VERIFICATION_CACHE_SIZE` tuning; the negative TTL is a fixed internal constant.

## Security Considerations

- **Hash validation**: Prevents mempool from associating incorrect hashes with intents.
- **Cache poisoning**: Not a concern since the solver only caches results of its own verification, and the key now includes the signature and domain, so one signature's verdict can never be read back for a different signature over the same hash.
- **Memory bounds**: LRU eviction prevents DoS via cache exhaustion; negative-result TTL additionally prevents an attacker from "burning" a hash permanently by submitting one bad signature before the user submits the real one.
- **Availability / correctness**: A corrected resubmission of a previously-rejected intent is now reconsidered and can be filled — closing the "the user's resubmission is silently ignored" failure mode.

## Future Enhancements

Potential improvements for consideration:

1. **Metrics**: Export cache hit/miss rates and size for monitoring, including negative-TTL expiries.
2. **Persistent cache**: Save cache to disk for warm restarts (low priority).
3. **Batch verification**: Group multiple verifications for potential performance gains.
4. **Rate limiting per hash**: Consider a lightweight rate limit on repeated invalid submissions of the same hash, independent of the verification cache, if bad-signature spam becomes a concern in practice.

## References

- Issue #350: Solver: VerificationCache is keyed on the intent hash alone and caches negative results indefinitely
- EIP-712: https://eips.ethereum.org/EIPS/eip-712
- ECDSA recovery: https://en.wikipedia.org/wiki/Elliptic_Curve_Digital_Signature_Algorithm
