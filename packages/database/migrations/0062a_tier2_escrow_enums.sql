-- Tier-2 admission starts in draft. This enum label must commit in its own
-- migration before 0062b can use it in constraints and functions.
ALTER TYPE public.bounty_status ADD VALUE IF NOT EXISTS 'draft';
