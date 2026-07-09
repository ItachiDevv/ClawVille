-- SAP V2 release path: settle-confirmed, awaiting dispute-window finalize.
-- Standalone by design: ALTER TYPE ... ADD VALUE must not share a transaction
-- with statements that use the new value on older supported PostgreSQL versions.
-- Additive and idempotent; never DROP or rewrite an existing enum value.

ALTER TYPE sap_escrow_settlement_status ADD VALUE IF NOT EXISTS 'pending';
