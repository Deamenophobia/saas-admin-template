ALTER TABLE organizations ADD COLUMN suspended BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE integration_events (
  id UUID PRIMARY KEY,
  organization_id UUID,
  type TEXT NOT NULL,
  body JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at TIMESTAMPTZ,
  lease_until TIMESTAMPTZ,
  lease_token UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX integration_events_delivered_at_available_at_idx ON integration_events(delivered_at, available_at);
CREATE INDEX integration_events_organization_id_created_at_idx ON integration_events(organization_id, created_at);
