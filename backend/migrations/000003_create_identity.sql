-- +goose Up
CREATE TABLE app.users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL,
    display_name text NOT NULL,
    password_hash text NOT NULL,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    bootstrap_admin boolean NOT NULL DEFAULT false,
    last_login_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (email = lower(email) AND email = btrim(email) AND octet_length(email) BETWEEN 3 AND 254 AND
           email ~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'),
    CHECK (display_name = btrim(display_name) AND char_length(display_name) BETWEEN 1 AND 100),
    CHECK (octet_length(password_hash) BETWEEN 60 AND 255),
    CHECK (updated_at >= created_at AND (last_login_at IS NULL OR last_login_at >= created_at))
);
CREATE UNIQUE INDEX users_email_unique ON app.users (email);
CREATE UNIQUE INDEX users_single_bootstrap_admin ON app.users (bootstrap_admin) WHERE bootstrap_admin;

CREATE TABLE app.sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    csrf_hash bytea NOT NULL CHECK (octet_length(csrf_hash) = 32),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '12 hours 1 minute'),
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX sessions_user_active ON app.sessions (user_id, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry ON app.sessions (expires_at) WHERE revoked_at IS NULL;

-- Keep credential/session lookup behind narrow invoker contracts rather than
-- granting the runtime role bulk reads of identity tables.
-- +goose StatementBegin
CREATE FUNCTION app.authentication_identity(candidate_email text)
RETURNS TABLE(id uuid, email text, display_name text, password_hash text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog ROWS 1 AS $$
    SELECT u.id, u.email, u.display_name, u.password_hash, u.status
    FROM app.users u WHERE u.email = candidate_email;
$$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.lock_authentication_identity(candidate_id uuid)
RETURNS TABLE(password_hash text, status text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog ROWS 1 AS $$
    SELECT u.password_hash, u.status FROM app.users u WHERE u.id = candidate_id FOR UPDATE;
$$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.current_identity(candidate_token_hash bytea, checked_at timestamptz)
RETURNS TABLE(session_id uuid, user_id uuid, email text, display_name text, expires_at timestamptz, csrf_hash bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog ROWS 1 AS $$
    SELECT s.id, u.id, u.email, u.display_name, s.expires_at, s.csrf_hash
    FROM app.sessions s JOIN app.users u ON u.id = s.user_id
    WHERE s.token_hash = candidate_token_hash AND s.revoked_at IS NULL
      AND s.expires_at > checked_at AND u.status = 'active';
$$;
-- +goose StatementEnd
REVOKE ALL ON FUNCTION app.authentication_identity(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.lock_authentication_identity(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.current_identity(bytea,timestamptz) FROM PUBLIC;
REVOKE ALL ON TABLE app.users, app.sessions FROM PUBLIC;

-- Runtime grants are provisioned explicitly for the deployment role after migration.

-- +goose Down
LOCK TABLE app.sessions, app.users IN ACCESS EXCLUSIVE MODE;
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM app.sessions) OR EXISTS (SELECT 1 FROM app.users) THEN
        RAISE EXCEPTION 'Rollback refused: identity data is not empty';
    END IF;
END;
$$;
-- +goose StatementEnd
DROP FUNCTION app.current_identity(bytea,timestamptz);
DROP FUNCTION app.lock_authentication_identity(uuid);
DROP FUNCTION app.authentication_identity(text);
DROP TABLE app.sessions;
DROP TABLE app.users;
