-- Door-2 verify wallet purpose. ALONE in its own file on purpose: migrate-ci
-- runs each *.sql as one implicit transaction and `ALTER TYPE ... ADD VALUE`
-- cannot run inside a transaction block, so it must not share a file with any
-- other statement (same shape as 0057a for 'sap-gas-sponsor').
ALTER TYPE treasury_purpose ADD VALUE IF NOT EXISTS 'land-hold-verify';
