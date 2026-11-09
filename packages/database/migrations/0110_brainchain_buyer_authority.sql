ALTER TABLE users ADD COLUMN IF NOT EXISTS linked_wallet_authority_version bigint NOT NULL DEFAULT 0;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='users'::regclass AND conname='users_linked_wallet_authority_version_bound') THEN
  ALTER TABLE users ADD CONSTRAINT users_linked_wallet_authority_version_bound CHECK(linked_wallet_authority_version>=0 AND linked_wallet_authority_version<=9007199254740991);
 END IF;
END $$;
CREATE OR REPLACE FUNCTION linked_wallet_authority_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.linked_wallet_pubkey IS DISTINCT FROM OLD.linked_wallet_pubkey OR NEW.linked_wallet_at IS DISTINCT FROM OLD.linked_wallet_at THEN
  NEW.linked_wallet_authority_version := OLD.linked_wallet_authority_version + 1;
 ELSIF NEW.linked_wallet_authority_version IS DISTINCT FROM OLD.linked_wallet_authority_version THEN
  RAISE EXCEPTION 'Linked wallet authority version is monotonic';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS users_linked_wallet_authority_revision ON users;
CREATE TRIGGER users_linked_wallet_authority_revision BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION linked_wallet_authority_revision();
ALTER TABLE brainchain_buyer_orders ADD COLUMN IF NOT EXISTS human_approval_wallet varchar(44);
ALTER TABLE brainchain_buyer_orders ADD COLUMN IF NOT EXISTS human_approval_wallet_version bigint;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='brainchain_buyer_orders'::regclass AND conname='brainchain_buyer_approval_wallet_tuple') THEN
  ALTER TABLE brainchain_buyer_orders ADD CONSTRAINT brainchain_buyer_approval_wallet_tuple CHECK
   ((human_approval_wallet IS NULL AND human_approval_wallet_version IS NULL) OR
    (human_approval_wallet IS NOT NULL AND human_approval_wallet_version IS NOT NULL AND human_approval_wallet_version>=0 AND human_approval_wallet_version<=9007199254740991));
 END IF;
END $$;
