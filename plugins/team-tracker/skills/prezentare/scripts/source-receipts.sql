-- Install in the Motion database through apply_migration, never execute during inspect.
-- Atomic receipt and product-row mutations are performed in one transaction by the adapter.
CREATE TABLE public.tt_demo_source_receipts (
  adapter text NOT NULL CHECK (adapter = 'motion'),
  presentation_id uuid NOT NULL,
  resource_key text NOT NULL CHECK (length(resource_key) BETWEEN 1 AND 160),
  run_id uuid NOT NULL,
  resource_table text NOT NULL,
  identity jsonb NOT NULL CHECK (jsonb_typeof(identity) = 'object' AND identity <> '{}'::jsonb),
  owner_id uuid NOT NULL,
  ownership text NOT NULL CHECK (ownership IN ('created', 'reused')),
  request_hash text NOT NULL,
  fingerprint text NOT NULL,
  state text NOT NULL CHECK (state IN ('ready', 'reset')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (adapter, presentation_id, resource_key),
  UNIQUE (adapter, resource_table, identity)
);
ALTER TABLE public.tt_demo_source_receipts ENABLE ROW LEVEL SECURITY;
-- New tables inherit ALTER DEFAULT PRIVILEGES grants. Clear them before the
-- intended grant, otherwise DELETE/TRUNCATE can survive the narrower GRANT.
REVOKE ALL ON public.tt_demo_source_receipts FROM PUBLIC, anon, authenticated, service_role;
DO $receipt_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agent_sql') THEN
    EXECUTE 'REVOKE ALL ON public.tt_demo_source_receipts FROM agent_sql';
  END IF;
END $receipt_acl$;
GRANT SELECT, INSERT, UPDATE ON public.tt_demo_source_receipts TO service_role;
COMMENT ON TABLE public.tt_demo_source_receipts IS
  'Private presentation resource ownership receipts. No credentials or raw row payloads. Do not delete receipts to retry an operation.';
