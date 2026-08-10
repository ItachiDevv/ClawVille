-- Final branch-only enum pre-step. PostgreSQL requires a commit after adding an
-- enum value before 0057b can use it in the singleton index predicate.
ALTER TYPE treasury_purpose ADD VALUE IF NOT EXISTS 'sap-gas-sponsor';
