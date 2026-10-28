-- Optional example product tables. Never part of the core identity migrations.
CREATE TABLE demo_team_projects (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX demo_team_projects_organization_id_idx ON demo_team_projects(organization_id);
CREATE TABLE demo_api_usage (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  calls INTEGER NOT NULL DEFAULT 0 CHECK (calls >= 0),
  quota INTEGER NOT NULL CHECK (quota > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
