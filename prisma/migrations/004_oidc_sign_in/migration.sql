ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
CREATE TABLE external_identities (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (issuer, subject),
  UNIQUE (user_id, provider_id)
);
ALTER TABLE sessions ADD COLUMN sso_identity_id UUID REFERENCES external_identities(id) ON DELETE CASCADE;
CREATE INDEX sessions_sso_identity_id_idx ON sessions(sso_identity_id);
CREATE TABLE sso_flows (
  id UUID PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  binding_hash TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  encrypted_verifier TEXT NOT NULL,
  link_session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX sso_flows_expires_at_idx ON sso_flows(expires_at);
CREATE INDEX sso_flows_link_session_id_idx ON sso_flows(link_session_id);
CREATE TABLE sso_mfa_challenges (
  id UUID PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  identity_id UUID NOT NULL REFERENCES external_identities(id) ON DELETE CASCADE,
  config_hash TEXT NOT NULL,
  attempts_left INTEGER NOT NULL CHECK (attempts_left >= 0),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX sso_mfa_challenges_expires_at_idx ON sso_mfa_challenges(expires_at);
CREATE INDEX sso_mfa_challenges_identity_id_idx ON sso_mfa_challenges(identity_id);
