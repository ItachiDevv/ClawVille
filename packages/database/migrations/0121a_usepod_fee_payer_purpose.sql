-- UsePod fee wallet purpose. ALONE in its own file: migrate-ci runs each *.sql
-- as one implicit transaction and `ALTER TYPE ... ADD VALUE` cannot run inside
-- a transaction block (same shape as 0060a for 'land-hold-verify').
ALTER TYPE treasury_purpose ADD VALUE IF NOT EXISTS 'usepod-fee-payer';
