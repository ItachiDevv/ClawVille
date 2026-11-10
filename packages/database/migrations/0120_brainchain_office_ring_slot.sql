-- Founder 2026-11-10: the BrainChain Office replaces the Salty Spitoon at ring slot api-integrations.
-- Data only: the location id stays, so quests, paths and tools keep working. Idempotent.
UPDATE map_locations
SET name = 'BrainChain Office',
    description = 'Learn BrainChain external task work and testnet worker setup, and master REST APIs, GraphQL, webhooks, OAuth, and integrations.'
WHERE id = 'api-integrations'
  AND (name IS DISTINCT FROM 'BrainChain Office'
    OR description IS DISTINCT FROM 'Learn BrainChain external task work and testnet worker setup, and master REST APIs, GraphQL, webhooks, OAuth, and integrations.');

-- The stored building curriculum names the old building and resident. Deterministic rename (no model
-- call); content_hash follows the new bytes so manifest clients re-fetch. Idempotent.
UPDATE building_skills
SET content = replace(replace(content, 'Salty Spitoon', 'BrainChain Office'), 'Flying Dutchman', 'Cortex'),
    description = replace(replace(description, 'Salty Spitoon', 'BrainChain Office'), 'Flying Dutchman', 'Cortex'),
    content_hash = encode(sha256(convert_to(replace(replace(content, 'Salty Spitoon', 'BrainChain Office'), 'Flying Dutchman', 'Cortex'), 'UTF8')), 'hex'),
    updated_at = now()
WHERE building_id = 'api-integrations'
  AND (content LIKE '%Salty Spitoon%' OR content LIKE '%Flying Dutchman%'
    OR description LIKE '%Salty Spitoon%' OR description LIKE '%Flying Dutchman%');
