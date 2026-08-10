-- PostgreSQL requires a commit after adding an enum value before it can be used.
ALTER TYPE treasury_purpose ADD VALUE IF NOT EXISTS 'sap-gas-sponsor';
