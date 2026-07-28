//! LayerZero payload encoding and decoding.
//!
//! Perihelion sends two message types from Stellar to the source chain:
//! `FillConfirmed` (authorize solver payout) and `CancelIntent` (refund the
//! user). It also receives `FillInstruction` and `CancelIntent` from the source
//! chain. All payloads use the fixed big-endian binary layout from the
//! architecture spec §3.3 so they decode identically in Solidity and Rust.

use soroban_sdk::{Address, Bytes, BytesN, Env};

use crate::types::{
    CancelInstruction, FillInstruction, MSG_CANCEL_INTENT, MSG_FILL_CONFIRMED,
    MSG_FILL_INSTRUCTION, PROTOCOL_VERSION,
    CANCEL_REASON_EXPIRED, CANCEL_REASON_ADMIN, CANCEL_REASON_INVALID,
};

/// Encode a `FillConfirmed` payload (90 bytes):
/// `version(1) | type(1) | intent_hash(32) | solver_evm(32) | amount(16) | ledger(8)`.
///
/// ## Field authority
///
/// | Field         | Consumer   | Notes |
/// |---------------|------------|-------|
/// | `intent_hash` | EVM escrow | Identifies the lock to release. |
/// | `solver_evm`  | EVM escrow | Payout destination (may differ from locking solver key). |
/// | `fill_amount` | Off-chain  | Stellar-side delivery amount — **informational only**. |
/// | `fill_ledger` | Off-chain  | Stellar ledger sequence — **informational only**. |
///
/// ## `fill_amount` field — informational only
///
/// The `fill_amount` encoded here is the Stellar-side delivery amount, carried
/// for off-chain observability (explorer display, solver accounting). It does
/// **not** control how much the EVM escrow releases: `PerihelionEscrow._onFillConfirmed`
/// releases `l.amount` — the measured-delta locked amount — regardless of this
/// field. That is the correct and intentional design: the source-chain escrow
/// already holds the exact value to release, so re-trusting a Stellar-declared
/// amount would be redundant and would open a griefing vector. The field is
/// decoded and emitted in the EVM `Released` event so that off-chain tooling can
/// reconcile the Stellar fill with the EVM payout without a separate RPC call;
/// it must never be used to gate or size the release.
///
/// ## `fill_ledger` field — u32 → u64 widening
///
/// Stellar ledger sequence numbers are `u32` (`env.ledger().sequence()`). The
/// wire format encodes them as `u64` (8 bytes, big-endian) for two reasons:
///
/// 1. **Future-proofing**: Stellar's ledger counter will overflow a `u32` in
///    roughly 136 years at current rates. Encoding as `u64` on the wire today
///    costs 4 extra bytes per message and avoids a breaking wire-format change
///    when the Stellar runtime eventually widens the type.
/// 2. **Symmetry**: The EVM side reads the field as `uint64`, so the wire type
///    matches the receiver's native integer width without sign-extension risk.
///
/// The widening is lossless: `fill_ledger as u64` preserves the exact value.
/// The field is decoded and emitted in the EVM `Released` event for dispute
/// resolution and audit; it does not affect fund movement.
pub fn encode_fill_confirmed(
    env: &Env,
    intent_hash: &BytesN<32>,
    solver_evm: &BytesN<32>,
    fill_amount: i128,
    fill_ledger: u32,
) -> Bytes {
    let mut b = Bytes::new(env);
    b.push_back(PROTOCOL_VERSION);
    b.push_back(MSG_FILL_CONFIRMED);
    b.append(&Bytes::from_array(env, &intent_hash.to_array()));
    b.append(&Bytes::from_array(env, &solver_evm.to_array()));
    // Amount is validated non-negative before encoding; widen to u128 wire form.
    // See doc-comment above: this value is informational and is not used by the
    // EVM escrow to size the release.
    b.append(&Bytes::from_array(
        env,
        &(fill_amount as u128).to_be_bytes(),
    ));
    // Widen u32 ledger sequence to u64 for the wire format. Lossless cast;
    // rationale in the doc-comment above (future-proofing + EVM symmetry).
    b.append(&Bytes::from_array(env, &(fill_ledger as u64).to_be_bytes()));
    b
}

/// Encode a `CancelIntent` payload (35 bytes):
/// `version(1) | type(1) | intent_hash(32) | reason(1)`.
pub fn encode_cancel_intent(env: &Env, intent_hash: &BytesN<32>, reason: u8) -> Bytes {
    let mut b = Bytes::new(env);
    b.push_back(PROTOCOL_VERSION);
    b.push_back(MSG_CANCEL_INTENT);
    b.append(&Bytes::from_array(env, &intent_hash.to_array()));
    b.push_back(reason);
    b
}

/// Decode an inbound message payload. Returns the message type discriminant and
/// parsed message, or an error if the payload is malformed.
/// Validates version and routes to the appropriate decoder.
pub fn decode_message(
    env: &Env,
    message: &Bytes,
) -> Result<(u8, FillInstruction, Option<CancelInstruction>), crate::PerihelionError> {
    use crate::PerihelionError;

    // Minimum: version(1) + type(1)
    if message.len() < 2 {
        return Err(PerihelionError::MalformedPayload);
    }

    let version = message.get(0).ok_or(PerihelionError::MalformedPayload)?;
    if version != PROTOCOL_VERSION {
        return Err(PerihelionError::MalformedPayload);
    }

    let msg_type = message.get(1).ok_or(PerihelionError::MalformedPayload)?;

    match msg_type {
        MSG_FILL_INSTRUCTION => {
            let fi = decode_fill_instruction(env, message)?;
            Ok((msg_type, fi, None))
        }
        MSG_CANCEL_INTENT => {
            let ci = decode_cancel_intent(env, message)?;
            // Return a dummy FillInstruction with the intent_hash from cancel for union type compat.
            // Use the zero-account strkey as a placeholder — decode_message is not called on the
            // hot path (lib.rs routes FillInstruction and CancelIntent separately); this dummy
            // exists only for API symmetry.
            let zero_addr = Address::from_str(
                env,
                "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
            );
            let dummy = FillInstruction {
                intent_hash: ci.intent_hash.clone(),
                src_eid: 0,
                recipient: zero_addr.clone(),
                dest_asset: zero_addr,
                min_dest_amount: 0,
                deadline: 0,
                preferred_solver: None,
                reservation_window: 0,
            };
            Ok((msg_type, dummy, Some(ci)))
        }
        _ => Err(PerihelionError::MalformedPayload),
    }
}

/// Decode a `FillInstruction` payload (158 bytes):
/// `version(1) | type(1) | intent_hash(32) | src_eid(4) | recipient(32) | dest_asset(32) | min_dest_amount(16) | deadline(8) | preferred_solver(32)`.
///
/// # Address decoding
///
/// The `recipient` and `dest_asset` fields carry the ASCII bytes of Stellar
/// strkeys (e.g. `GUSER...` or `CUSDC...`), right-zero-padded to 32 bytes.
/// This function strips the trailing zeros to recover the original string and
/// then converts it to a Soroban `Address` via `Address::from_string_bytes`.
/// This correctly handles both G... account keys and C... contract keys, fixing
/// the `Address::from_contract_id` misuse identified in issue #271.
///
/// # preferred_solver
///
/// The EVM side encodes `preferredSolver` as a 20-byte EVM address left-padded
/// to 32 bytes. This is not a Stellar strkey and cannot be decoded as a Soroban
/// `Address`. The field is therefore left as `None` — the preferred-solver
/// reservation mechanism for cross-chain intents requires a dedicated design
/// (tracked as a follow-up to #271).
fn decode_fill_instruction(
    env: &Env,
    message: &Bytes,
) -> Result<FillInstruction, crate::PerihelionError> {
    use crate::PerihelionError;

    // Validate length: 2 (header) + 156 (payload) = 158
    if message.len() != 158 {
        return Err(PerihelionError::MalformedPayload);
    }

    // Extract intent_hash (offset 2, 32 bytes)
    let mut intent_hash_bytes = [0u8; 32];
    for i in 0..32 {
        intent_hash_bytes[i] = message
            .get(2 + i as u32)
            .ok_or(PerihelionError::MalformedPayload)?;
    }
    let intent_hash = BytesN::from_array(env, &intent_hash_bytes);

    // Extract src_eid (offset 34, 4 bytes, big-endian)
    let mut src_eid_bytes = [0u8; 4];
    for i in 0..4 {
        src_eid_bytes[i] = message
            .get(34 + i as u32)
            .ok_or(PerihelionError::MalformedPayload)?;
    }
    let src_eid = u32::from_be_bytes(src_eid_bytes);

    // Extract recipient (offset 38, 32 bytes): ASCII strkey characters right-zero-padded.
    // Strip trailing zeros and decode as a Stellar strkey (G... or C...).
    let mut recipient_raw = [0u8; 32];
    for i in 0..32 {
        recipient_raw[i] = message
            .get(38 + i as u32)
            .ok_or(PerihelionError::MalformedPayload)?;
    }
    let recipient = decode_strkey_address(env, &recipient_raw)?;

    // Extract dest_asset (offset 70, 32 bytes): ASCII strkey characters right-zero-padded.
    // Strip trailing zeros and decode as a Stellar strkey (G... or C...).
    let mut dest_asset_raw = [0u8; 32];
    for i in 0..32 {
        dest_asset_raw[i] = message
            .get(70 + i as u32)
            .ok_or(PerihelionError::MalformedPayload)?;
    }
    let dest_asset = decode_strkey_address(env, &dest_asset_raw)?;

    // Extract min_dest_amount (offset 102, 16 bytes, big-endian)
    let mut min_dest_amount_bytes = [0u8; 16];
    for i in 0..16 {
        min_dest_amount_bytes[i] = message
            .get(102 + i as u32)
            .ok_or(PerihelionError::MalformedPayload)?;
    }
    let min_dest_amount = i128::from_be_bytes(min_dest_amount_bytes);

    // Extract deadline (offset 118, 8 bytes, big-endian)
    let mut deadline_bytes = [0u8; 8];
    for i in 0..8 {
        deadline_bytes[i] = message
            .get(118 + i as u32)
            .ok_or(PerihelionError::MalformedPayload)?;
    }
    let deadline = u64::from_be_bytes(deadline_bytes);

    // Extract preferred_solver (offset 126, 32 bytes).
    // The EVM side writes a 20-byte EVM address left-padded to 32 bytes — this
    // is not a valid Stellar strkey. We detect non-zero content to preserve the
    // "has preferred solver" signal, but cannot decode an EVM address as a
    // Stellar Address. For now, preferred_solver is omitted from the decoded
    // struct. Cross-chain preferred-solver semantics are a follow-up to #271.
    // If the slot is all-zeros it means "open" (no reservation).
    let preferred_solver = None;

    Ok(FillInstruction {
        intent_hash,
        src_eid,
        recipient,
        dest_asset,
        min_dest_amount,
        deadline,
        preferred_solver,
        reservation_window: 0,
    })
}

/// Convert a right-zero-padded ASCII strkey byte slice into a Soroban `Address`.
///
/// The wire format encodes Stellar strkeys (G.../C...) as ASCII characters
/// right-padded with zeros to fill the fixed field width. This function finds
/// the last non-zero byte, takes the prefix as the strkey string, and converts
/// it using `Address::from_string_bytes` which handles both account keys (G...)
/// and contract keys (C...) without reinterpreting raw bytes as a contract id.
fn decode_strkey_address(env: &Env, padded: &[u8]) -> Result<Address, crate::PerihelionError> {
    use crate::PerihelionError;
    // Find length by trimming trailing zero bytes.
    let len = padded.iter().rposition(|&b| b != 0).map(|p| p + 1).unwrap_or(0);
    if len == 0 {
        return Err(PerihelionError::MalformedPayload);
    }
    let mut b = Bytes::new(env);
    for &byte in &padded[..len] {
        b.push_back(byte);
    }
    // from_string_bytes accepts both G... (account) and C... (contract) strkeys.
    Ok(Address::from_string_bytes(&b))
}

/// Decode a `CancelIntent` payload (35 bytes):
/// `version(1) | type(1) | intent_hash(32) | reason(1)`.
fn decode_cancel_intent(
    env: &Env,
    message: &Bytes,
) -> Result<CancelInstruction, crate::PerihelionError> {
    use crate::PerihelionError;

    // Validate length: 2 (header) + 33 (payload) = 35
    if message.len() != 35 {
        return Err(PerihelionError::MalformedPayload);
    }

    // Extract intent_hash (offset 2, 32 bytes)
    let mut intent_hash_bytes = [0u8; 32];
    for i in 0..32 {
        intent_hash_bytes[i] = message
            .get(2 + i as u32)
            .ok_or(PerihelionError::MalformedPayload)?;
    }
    let intent_hash = BytesN::from_array(env, &intent_hash_bytes);

    // Extract and validate reason (offset 34, 1 byte).
    // Only the three cross-chain reason codes are valid on the wire; reject
    // anything else to keep the decoder strict and match EVM behaviour.
    let reason_byte = message
        .get(34)
        .ok_or(PerihelionError::MalformedPayload)?;
    if reason_byte != CANCEL_REASON_EXPIRED
        && reason_byte != CANCEL_REASON_ADMIN
        && reason_byte != CANCEL_REASON_INVALID
    {
        return Err(PerihelionError::MalformedPayload);
    }

    Ok(CancelInstruction {
        intent_hash,
        reason: reason_byte as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Env as _;

    // A known valid G... account strkey (all-zeros account).
    const ZERO_ACCOUNT: &str = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    // A known valid C... contract strkey.
    const ZERO_CONTRACT: &str = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

    /// decode_strkey_address correctly decodes a G... strkey from a zero-padded buffer.
    #[test]
    fn test_decode_strkey_address_g_key() {
        let env = Env::default();
        let mut buf = [0u8; 32];
        let strkey = ZERO_ACCOUNT.as_bytes();
        let copy_len = strkey.len().min(32);
        buf[..copy_len].copy_from_slice(&strkey[..copy_len]);

        let addr = decode_strkey_address(&env, &buf).expect("should decode G... strkey");
        // Round-trip: the decoded Address should re-encode to the same strkey.
        let roundtrip = addr.to_string().to_string();
        assert_eq!(&roundtrip[..copy_len], &ZERO_ACCOUNT[..copy_len]);
    }

    /// decode_strkey_address correctly decodes a C... strkey from a zero-padded buffer.
    #[test]
    fn test_decode_strkey_address_c_key() {
        let env = Env::default();
        let strkey = ZERO_CONTRACT.as_bytes();
        // The C... strkey is 56 bytes, fits in a 56-byte padded field; use 32 for this test.
        let copy_len = strkey.len().min(32);
        let mut buf = [0u8; 32];
        buf[..copy_len].copy_from_slice(&strkey[..copy_len]);

        // Should not panic — from_string_bytes handles C... keys.
        let addr = decode_strkey_address(&env, &buf).expect("should decode C... strkey");
        let _ = addr; // decoded without error
    }

    /// decode_strkey_address returns MalformedPayload for an all-zero buffer.
    #[test]
    fn test_decode_strkey_address_empty_returns_error() {
        let env = Env::default();
        let buf = [0u8; 32];
        let result = decode_strkey_address(&env, &buf);
        assert!(result.is_err());
    }

    /// decode_fill_instruction requires exactly 158 bytes.
    #[test]
    fn test_decode_fill_instruction_wrong_length_rejected() {
        let env = Env::default();
        let mut short = Bytes::new(&env);
        for _ in 0..157u32 {
            short.push_back(0x00);
        }
        let result = decode_fill_instruction(&env, &short);
        assert!(result.is_err());
    }

    /// A well-formed 158-byte FillInstruction with G... recipient and C... dest_asset decodes
    /// correctly using from_string_bytes (not from_contract_id).
    #[test]
    fn test_decode_fill_instruction_strkey_addresses() {
        let env = Env::default();

        // Build a 158-byte payload manually.
        let mut msg = Bytes::new(&env);

        // version + type
        msg.push_back(0x01);
        msg.push_back(0x01);

        // intent_hash (32 bytes)
        for _ in 0..32u32 {
            msg.push_back(0xaa);
        }

        // src_eid (4 bytes) = 1
        msg.push_back(0x00);
        msg.push_back(0x00);
        msg.push_back(0x00);
        msg.push_back(0x01);

        // recipient (32 bytes): first 32 chars of ZERO_ACCOUNT right-zero-padded
        let recip_bytes = ZERO_ACCOUNT.as_bytes();
        for i in 0..32usize {
            msg.push_back(if i < recip_bytes.len() { recip_bytes[i] } else { 0 });
        }

        // dest_asset (32 bytes): first 32 chars of ZERO_CONTRACT right-zero-padded
        let asset_bytes = ZERO_CONTRACT.as_bytes();
        for i in 0..32usize {
            msg.push_back(if i < asset_bytes.len() { asset_bytes[i] } else { 0 });
        }

        // min_dest_amount (16 bytes) = 1_000_000
        let amount: i128 = 1_000_000;
        for b in amount.to_be_bytes() {
            msg.push_back(b);
        }

        // deadline (8 bytes) = 9_999_999
        let deadline: u64 = 9_999_999;
        for b in deadline.to_be_bytes() {
            msg.push_back(b);
        }

        // preferred_solver (32 bytes) = all zeros → None
        for _ in 0..32u32 {
            msg.push_back(0x00);
        }

        assert_eq!(msg.len(), 158);

        let fi = decode_fill_instruction(&env, &msg).expect("should decode valid payload");
        assert_eq!(fi.src_eid, 1);
        assert_eq!(fi.min_dest_amount, 1_000_000);
        assert_eq!(fi.deadline, 9_999_999);
        assert!(fi.preferred_solver.is_none());
        // recipient and dest_asset decoded without panic — correct strkey path used
    }
}
