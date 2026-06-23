---
name: amount-discipline
description: "Ledger helpers require a positive integer (throw else) and debit asserts balance>=amount (InsufficientTokensError); callers must guard 0/NULL prices before calling"
category: constraint
confidence: high
date: 2026-06-22
---

# Amount discipline at the primitive

**At the helper:** both `creditInTx`/`debitInTx` throw if `!Number.isInteger(amount) || amount <= 0` (`claw-token-ledger.ts:81/115`) — callers pass the MAGNITUDE; debit stores it negative internally (`-input.amount`, l.140). `debitInTx` asserts `row.claw_tokens >= amount` else throws `InsufficientTokensError` (127). No fractional, negative, zero, or overflow CT can enter the ledger.

**At the caller:** guard 0/NULL prices BEFORE calling — `land.ts:892` blocks a 0/NULL parcel price from reaching debit. A negative passed to credit would THROW (not mint), but guarding upstream gives a clean 400 instead of a 500.

**State: ENFORCED at the primitive.** A new caller passing a possibly-zero/NULL price must add its own guard; the helper's throw is the backstop, not the UX.

Related: `[[ledger-only-write-path]]`, `[[atomic-compose-into-caller-tx]]`.
