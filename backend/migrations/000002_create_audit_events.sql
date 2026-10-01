-- +goose Up
CREATE TABLE app.audit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version = 1),
    actor_kind text NOT NULL CHECK (actor_kind IN ('system', 'user')),
    actor_user_id uuid,
    event_name text NOT NULL,
    resource_kind text NOT NULL CHECK (resource_kind ~ '^[a-z][a-z0-9_]{0,31}$'),
    resource_id uuid NOT NULL CHECK (resource_id <> '00000000-0000-0000-0000-000000000000'),
    client_id uuid CHECK (client_id <> '00000000-0000-0000-0000-000000000000'),
    request_id text NOT NULL CHECK (request_id ~ '^[A-Z2-7]{26}$'),
    before_state jsonb NOT NULL,
    after_state jsonb NOT NULL,
    metadata jsonb NOT NULL,
    CHECK ((actor_kind = 'system' AND actor_user_id IS NULL) OR
           (actor_kind = 'user' AND actor_user_id IS NOT NULL AND
            actor_user_id <> '00000000-0000-0000-0000-000000000000')),
    CHECK (event_name IN (resource_kind || '.created', resource_kind || '.updated',
                         resource_kind || '.archived', resource_kind || '.deleted')),
    CHECK (octet_length(before_state::text) <= 1024),
    CHECK (octet_length(after_state::text) <= 1024),
    CHECK (octet_length(metadata::text) <= 256 AND jsonb_typeof(metadata) = 'object' AND
           metadata - 'source' = '{}'::jsonb AND metadata ? 'source' AND
           jsonb_typeof(metadata->'source') = 'string' AND
           metadata->>'source' IN ('http', 'job', 'cli'))
);

-- Explicit key/type allowlists also reject raw SQL attempts to store secrets.
-- +goose StatementBegin
CREATE FUNCTION app.audit_snapshot_allowed(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
BEGIN
    IF value = 'null'::jsonb THEN RETURN true; END IF;
    IF jsonb_typeof(value) <> 'object' OR value - ARRAY['exists', 'revision'] <> '{}'::jsonb THEN
        RETURN false;
    END IF;
    IF value ? 'exists' AND jsonb_typeof(value->'exists') <> 'boolean' THEN RETURN false; END IF;
    IF value ? 'revision' THEN
        IF jsonb_typeof(value->'revision') <> 'number' OR
           value->>'revision' !~ '^(0|[1-9][0-9]*)$' THEN RETURN false; END IF;
        IF (value->>'revision')::numeric > 9223372036854775807 THEN RETURN false; END IF;
    END IF;
    RETURN true;
END;
$$;
-- +goose StatementEnd
REVOKE ALL ON FUNCTION app.audit_snapshot_allowed(jsonb) FROM PUBLIC;
ALTER TABLE app.audit_events ADD CONSTRAINT audit_before_allowlist CHECK (app.audit_snapshot_allowed(before_state));
ALTER TABLE app.audit_events ADD CONSTRAINT audit_after_allowlist CHECK (app.audit_snapshot_allowed(after_state));

CREATE INDEX audit_events_resource_time ON app.audit_events (resource_kind, resource_id, occurred_at, id);
CREATE INDEX audit_events_client_time ON app.audit_events (client_id, occurred_at, id) WHERE client_id IS NOT NULL;
CREATE INDEX audit_events_actor_time ON app.audit_events (actor_user_id, occurred_at, id) WHERE actor_user_id IS NOT NULL;
CREATE INDEX audit_events_request ON app.audit_events (request_id);

-- +goose StatementBegin
CREATE FUNCTION app.audit_deny_history_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    RAISE EXCEPTION 'Audit history is append-only' USING ERRCODE = '42501';
END;
$$;
-- +goose StatementEnd
REVOKE ALL ON FUNCTION app.audit_deny_history_change() FROM PUBLIC;
CREATE TRIGGER audit_history_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON app.audit_events
FOR EACH STATEMENT EXECUTE FUNCTION app.audit_deny_history_change();
ALTER TABLE app.audit_events ENABLE ALWAYS TRIGGER audit_history_append_only;
REVOKE ALL ON TABLE app.audit_events FROM PUBLIC;

-- No hardcoded deployment role or default privileges for future domain tables.
-- Provision column-level INSERT and snapshot validator EXECUTE separately.

-- +goose Down
-- Lock prevents a concurrent insert racing the emptiness check and table drop.
LOCK TABLE app.audit_events IN ACCESS EXCLUSIVE MODE;
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM app.audit_events) THEN
        RAISE EXCEPTION 'Rollback refused: audit history is not empty';
    END IF;
END;
$$;
-- +goose StatementEnd
DROP TABLE app.audit_events;
DROP FUNCTION app.audit_deny_history_change();
DROP FUNCTION app.audit_snapshot_allowed(jsonb);
