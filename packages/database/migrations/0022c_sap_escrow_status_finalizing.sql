-- SAP V2 release path: atomic permissionless-finalize claim.
-- One enum value per standalone migration keeps migrate-ci transaction-safe.

ALTER TYPE sap_escrow_settlement_status ADD VALUE IF NOT EXISTS 'finalizing';
