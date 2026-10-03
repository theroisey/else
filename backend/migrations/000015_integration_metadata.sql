-- +goose Up
INSERT INTO app.permissions(permission_key,scope_kind,description)
 VALUES ('integrations.view','client','View authorized integration connection metadata');
INSERT INTO app.role_permissions(id,role_id,permission_key,seeded)
 VALUES (gen_random_uuid(),'00000000-0000-4000-8000-000000000001','integrations.view',true);

-- Metadata only. Credential storage and verified lifecycle writers follow in
-- separate slices. No production/demo connection or provider success is seeded.
CREATE TABLE app.integration_connections (
 id uuid PRIMARY KEY CHECK(id<>'00000000-0000-0000-0000-000000000000'::uuid),
 client_id uuid NOT NULL REFERENCES app.clients(id) ON DELETE RESTRICT,
 provider text NOT NULL CHECK(provider='meta_ads'),
 provider_account_id text NOT NULL CHECK(provider_account_id ~ '^[1-9][0-9]{0,31}$'),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','connected','disconnect_pending','revocation_failed','disconnected','reauthorization_required')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
  CHECK(created_at>=TIMESTAMPTZ '0001-01-01 00:00:00+00' AND created_at<TIMESTAMPTZ '10000-01-01 00:00:00+00'),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
  CHECK(updated_at>=created_at AND updated_at<TIMESTAMPTZ '10000-01-01 00:00:00+00'),
 UNIQUE(provider,provider_account_id)
);
CREATE INDEX integration_connections_client_id ON app.integration_connections(client_id,id);

-- +goose StatementBegin
CREATE FUNCTION app.integration_connection_ownership_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (NEW.id,NEW.client_id,NEW.provider,NEW.provider_account_id,NEW.created_at) IS DISTINCT FROM
    (OLD.id,OLD.client_id,OLD.provider,OLD.provider_account_id,OLD.created_at) THEN
  RAISE invalid_parameter_value USING MESSAGE='Integration ownership is immutable';
 END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.integration_connection_ownership_guard() FROM PUBLIC;
CREATE TRIGGER integration_connection_ownership BEFORE UPDATE ON app.integration_connections
 FOR EACH ROW EXECUTE FUNCTION app.integration_connection_ownership_guard();

-- Reads wait behind exclusive lifecycle writers before performing fresh checks.
-- Only explicit safe columns cross the runtime boundary. Account IDs and
-- generation remain private; no SELECT privilege is granted on the table.
-- +goose StatementBegin
CREATE FUNCTION app.integration_connection_list(actor uuid,client uuid,after_id uuid,page_limit integer)
RETURNS TABLE(id uuid,client_id uuid,provider text,state text,revision bigint,created_at timestamptz,updated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR
 NOT app.authorization_allowed(actor,'integrations.view',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients c WHERE c.id=client) THEN RAISE no_data_found; END IF;
 IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 101 OR
 after_id='00000000-0000-0000-0000-000000000000'::uuid THEN RAISE invalid_parameter_value; END IF;
 RETURN QUERY SELECT c.id,c.client_id,c.provider,c.state,c.revision,c.created_at,c.updated_at
 FROM app.integration_connections c WHERE c.client_id=client AND (after_id IS NULL OR c.id>after_id)
 ORDER BY c.id LIMIT page_limit;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.integration_connection_list(uuid,uuid,uuid,integer) FROM PUBLIC;

-- +goose StatementBegin
CREATE FUNCTION app.integration_connection_read(actor uuid,client uuid,connection uuid)
RETURNS TABLE(id uuid,client_id uuid,provider text,state text,revision bigint,created_at timestamptz,updated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR
 NOT app.authorization_allowed(actor,'integrations.view',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients c WHERE c.id=client) THEN RAISE no_data_found; END IF;
 RETURN QUERY SELECT c.id,c.client_id,c.provider,c.state,c.revision,c.created_at,c.updated_at
 FROM app.integration_connections c WHERE c.client_id=client AND c.id=connection;
 IF NOT FOUND THEN RAISE no_data_found; END IF;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.integration_connection_read(uuid,uuid,uuid) FROM PUBLIC;

-- +goose Down
SELECT pg_advisory_xact_lock(871092650209);
LOCK TABLE app.integration_connections,app.role_permissions,app.permissions IN ACCESS EXCLUSIVE MODE;
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM app.integration_connections) OR
 EXISTS(SELECT 1 FROM app.role_permissions WHERE permission_key='integrations.view' AND
 (NOT seeded OR revoked_at IS NOT NULL OR role_id<>'00000000-0000-4000-8000-000000000001'::uuid)) THEN
  RAISE EXCEPTION 'Rollback refused: integration metadata or permission history is not empty';
 END IF;
END; $$;
-- +goose StatementEnd
DROP FUNCTION app.integration_connection_read(uuid,uuid,uuid);
DROP FUNCTION app.integration_connection_list(uuid,uuid,uuid,integer);
DROP TABLE app.integration_connections;
DROP FUNCTION app.integration_connection_ownership_guard();
DELETE FROM app.role_permissions WHERE permission_key='integrations.view';
DELETE FROM app.permissions WHERE permission_key='integrations.view';
