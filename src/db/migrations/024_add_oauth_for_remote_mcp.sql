-- 024: agentbill.dev as an OAuth 2.1 authorization server for its own remote
-- MCP endpoint, https://agentbill.dev/mcp.
--
-- Additive only: five new tables, no existing column changes, and nothing that
-- is live before this migration reads them. Apply it BEFORE the code that does.
--
-- The rule every table here keeps: no secret is stored. An authorization code,
-- an access token, a refresh token and a client secret are each 256 random bits
-- shown to the client once, and only their SHA-256 is written, the way
-- account_recovery_tokens (008) and email_sign_in_tokens (023) already work. A
-- copy of these tables cannot call /mcp.
--
-- oauth_clients
--   One row per client that can ask for authorization. Two kinds:
--     dcr   registered through POST /oauth/register (RFC 7591). client_id is
--           ours, agbcl_ and 32 hex. A registration nobody ever completes an
--           authorization with is pruned after a day (last_used_at NULL), which
--           is what keeps an open registration endpoint from growing this table
--           without bound; the per-network limit and a global ceiling on
--           unused rows are in src/lib/mcp-oauth.ts.
--     cimd  a Client ID Metadata Document: client_id is the HTTPS URL of the
--           client's own JSON document, fetched when it first asks and again
--           after an hour (fetched_at). Stored so the token endpoint and the
--           console can name it without fetching.
--   client_name is whatever the client sent. It is untrusted text, and every
--   page that shows it says so.
--
-- oauth_requests
--   An authorization request that was validated and is waiting for the person:
--   the consent page, or the sign-in in front of it. The page and the sign-in
--   carry only its id, so a long query string never has to survive /login, a
--   provider round trip or an email link. Single use, ten minutes.
--
-- oauth_codes
--   The authorization code. Bound to the client, the exact redirect_uri, the
--   PKCE S256 challenge, the scope and the resource. Single use, five minutes;
--   the CHECK makes the lifetime a property of the table. grant_id is set when
--   it is exchanged, so a second exchange can find and revoke what the first
--   one issued (RFC 6749 section 4.1.2).
--
-- oauth_grants
--   One approved connection: a person, the one account they own, one client,
--   its scope and the resource its tokens are for. This is the row the
--   console's "Connected apps" lists and its Disconnect revokes. revoked_reason
--   says who revoked it: the person, the reuse of a spent refresh token or of a
--   spent code, or a revocation request from the client.
--
-- oauth_tokens
--   Access tokens (one hour) and refresh tokens (thirty days), hashed. A
--   refresh token is spent by the rotation that replaces it (rotated_at); any
--   later use of it revokes the whole grant, because only a copy can present a
--   spent token twice.

SET lock_timeout = '3s';

BEGIN;

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id                  TEXT        PRIMARY KEY CHECK (length(client_id) BETWEEN 8 AND 512),
  kind                       TEXT        NOT NULL CHECK (kind IN ('dcr', 'cimd')),
  client_name                TEXT        CHECK (client_name IS NULL OR length(client_name) <= 200),
  client_uri                 TEXT        CHECK (client_uri IS NULL OR length(client_uri) <= 512),
  redirect_uris              TEXT[]      NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 10),
  token_endpoint_auth_method TEXT        NOT NULL DEFAULT 'none'
                                         CHECK (token_endpoint_auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
  client_secret_hash         TEXT        CHECK (client_secret_hash IS NULL OR client_secret_hash ~ '^[0-9a-f]{64}$'),
  scope                      TEXT        NOT NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  fetched_at                 TIMESTAMPTZ,
  last_used_at               TIMESTAMPTZ,
  -- A secret exactly when the method needs one, and never for a metadata
  -- document client, which authenticates by nothing but its URL.
  CONSTRAINT oauth_clients_secret_matches_method
    CHECK ((token_endpoint_auth_method = 'none') = (client_secret_hash IS NULL)),
  CONSTRAINT oauth_clients_cimd_is_public
    CHECK (kind = 'dcr' OR token_endpoint_auth_method = 'none')
);
-- The pruning sweep and the global ceiling read the never-used registrations.
CREATE INDEX IF NOT EXISTS idx_oauth_clients_unused
  ON oauth_clients (created_at) WHERE last_used_at IS NULL;

CREATE TABLE IF NOT EXISTS oauth_requests (
  id                    TEXT        PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32}$'),
  client_id             TEXT        NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri          TEXT        NOT NULL,
  state                 TEXT        CHECK (state IS NULL OR length(state) <= 512),
  code_challenge        TEXT        NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  scope                 TEXT        NOT NULL,
  resource              TEXT        NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ NOT NULL,
  consumed_at           TIMESTAMPTZ,
  CONSTRAINT oauth_requests_ten_minutes CHECK (expires_at <= created_at + INTERVAL '10 minutes')
);
CREATE INDEX IF NOT EXISTS idx_oauth_requests_expires ON oauth_requests (expires_at);

CREATE TABLE IF NOT EXISTS oauth_grants (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      TEXT        NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id     UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  scope          TEXT        NOT NULL,
  resource       TEXT        NOT NULL,
  -- What the person saw on the consent page, kept so the console shows the
  -- same words after a metadata document changes.
  client_name    TEXT        CHECK (client_name IS NULL OR length(client_name) <= 200),
  redirect_host  TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  revoked_reason TEXT        CHECK (revoked_reason IS NULL OR revoked_reason IN ('user', 'refresh_reuse', 'code_reuse', 'client'))
);
CREATE INDEX IF NOT EXISTS idx_oauth_grants_account_live
  ON oauth_grants (account_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT        PRIMARY KEY CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  client_id      TEXT        NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id     UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  redirect_uri   TEXT        NOT NULL,
  code_challenge TEXT        NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  scope          TEXT        NOT NULL,
  resource       TEXT        NOT NULL,
  client_name    TEXT,
  grant_id       UUID        REFERENCES oauth_grants(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  consumed_at    TIMESTAMPTZ,
  CONSTRAINT oauth_codes_five_minutes CHECK (expires_at <= created_at + INTERVAL '5 minutes')
);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_codes (expires_at);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT        PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  grant_id   UUID        NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  kind       TEXT        NOT NULL CHECK (kind IN ('access', 'refresh')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  rotated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT oauth_tokens_lifetime CHECK (
    (kind = 'access'  AND expires_at <= created_at + INTERVAL '1 hour') OR
    (kind = 'refresh' AND expires_at <= created_at + INTERVAL '30 days')
  ),
  CONSTRAINT oauth_tokens_only_refresh_rotates CHECK (kind = 'refresh' OR rotated_at IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_grant ON oauth_tokens (grant_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expires ON oauth_tokens (expires_at);

COMMIT;
