-- BrainChain pilot identity only. No signing, funds, task execution, or transfer authority.
-- Permanent address ownership prevents delayed hires from moving between avatars.
CREATE TABLE IF NOT EXISTS brainchain_worker_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  avatar_id uuid NOT NULL REFERENCES avatars(id) ON DELETE RESTRICT,
  environment varchar(8) NOT NULL,
  chain_id integer NOT NULL,
  address varchar(42) NOT NULL,
  proof_hash varchar(64) NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  requested_state varchar(12) NOT NULL DEFAULT 'paused',
  observed_eligibility varchar(24),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brainchain_binding_network CHECK ((environment='testnet' AND chain_id=274630) OR (environment='mainnet' AND chain_id=274663)),
  CONSTRAINT brainchain_binding_address_format CHECK (address ~ '^0x[0-9a-f]{40}$' AND address <> '0x0000000000000000000000000000000000000000'),
  CONSTRAINT brainchain_binding_proof_format CHECK (proof_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT brainchain_binding_local_state CHECK (requested_state IN ('paused','draining')),
  CONSTRAINT brainchain_binding_observed_state CHECK (observed_eligibility IS NULL OR observed_eligibility IN ('eligible','ineligible','unknown'))
);
CREATE UNIQUE INDEX IF NOT EXISTS brainchain_binding_address_owner ON brainchain_worker_bindings(environment,address);
CREATE UNIQUE INDEX IF NOT EXISTS brainchain_binding_avatar_environment ON brainchain_worker_bindings(avatar_id,environment);
CREATE UNIQUE INDEX IF NOT EXISTS brainchain_binding_owner_tuple ON brainchain_worker_bindings(id,avatar_id,environment,chain_id);

CREATE TABLE IF NOT EXISTS brainchain_binding_challenges (
  nonce_hash varchar(64) PRIMARY KEY,
  avatar_id uuid NOT NULL REFERENCES avatars(id) ON DELETE RESTRICT,
  environment varchar(8) NOT NULL,
  chain_id integer NOT NULL,
  address varchar(42) NOT NULL,
  domain varchar(80) NOT NULL,
  message text NOT NULL,
  message_hash varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  verification_attempts integer NOT NULL DEFAULT 0,
  CONSTRAINT brainchain_challenge_network CHECK ((environment='testnet' AND chain_id=274630) OR (environment='mainnet' AND chain_id=274663)),
  CONSTRAINT brainchain_challenge_address_format CHECK (address ~ '^0x[0-9a-f]{40}$' AND address <> '0x0000000000000000000000000000000000000000'),
  CONSTRAINT brainchain_challenge_hashes CHECK (nonce_hash ~ '^[0-9a-f]{64}$' AND message_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT brainchain_challenge_lifespan CHECK (expires_at > created_at AND expires_at <= created_at + interval '2 minutes'),
  CONSTRAINT brainchain_challenge_attempts CHECK (verification_attempts BETWEEN 0 AND 5)
);
CREATE INDEX IF NOT EXISTS brainchain_challenge_avatar_created ON brainchain_binding_challenges(avatar_id,created_at);
