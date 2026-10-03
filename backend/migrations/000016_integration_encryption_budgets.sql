-- +goose Up
-- Private per-material accounting in one authoritative database. No keys,
-- plaintext or ciphertext. Restore/clone requires fresh material before sealing.
CREATE TABLE app.integration_encryption_keys (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid() CHECK(id<>'00000000-0000-0000-0000-000000000000'::uuid),
 key_label text NOT NULL UNIQUE CHECK(key_label ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
 fingerprint bytea NOT NULL UNIQUE CHECK(octet_length(fingerprint)=32 AND fingerprint<>decode(repeat('00',32),'hex')),
 reservations bigint NOT NULL DEFAULT 0 CHECK(reservations BETWEEN 0 AND 16777216),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
  CHECK(created_at>=TIMESTAMPTZ '0001-01-01 00:00:00+00' AND created_at<TIMESTAMPTZ '10000-01-01 00:00:00+00')
);
REVOKE ALL ON app.integration_encryption_keys FROM PUBLIC;

-- +goose StatementBegin
CREATE FUNCTION app.integration_encryption_history_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Encryption accounting history is retained'; END IF;
 IF (NEW.id,NEW.key_label,NEW.fingerprint,NEW.created_at) IS DISTINCT FROM
 (OLD.id,OLD.key_label,OLD.fingerprint,OLD.created_at) OR NEW.reservations<>OLD.reservations+1 THEN
  RAISE EXCEPTION 'Encryption accounting identity and monotonic count are immutable';
 END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.integration_encryption_history_guard() FROM PUBLIC;
CREATE TRIGGER integration_encryption_history BEFORE UPDATE OR DELETE ON app.integration_encryption_keys
 FOR EACH ROW EXECUTE FUNCTION app.integration_encryption_history_guard();
CREATE TRIGGER integration_encryption_truncate BEFORE TRUNCATE ON app.integration_encryption_keys
 FOR EACH STATEMENT EXECUTE FUNCTION app.integration_encryption_history_guard();

-- Reservation is used only inside the reviewed typed audited transaction.
-- +goose StatementBegin
CREATE FUNCTION app.integration_encryption_reserve(actor uuid,client uuid,connection uuid,label text,digest bytea)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE used bigint; saved bytea;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR
 NOT app.authorization_allowed(actor,'integrations.manage',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients c WHERE c.id=client AND c.archived_at IS NULL) OR
 NOT EXISTS(SELECT 1 FROM app.integration_connections c WHERE c.id=connection AND c.client_id=client
  AND c.provider='meta_ads' AND c.state IN ('pending','connected','reauthorization_required')) THEN RAISE no_data_found; END IF;
 IF label IS NULL OR label !~ '^[a-z0-9][a-z0-9_-]{0,63}$' OR digest IS NULL OR
 octet_length(digest)<>32 OR digest=decode(repeat('00',32),'hex') THEN RAISE invalid_parameter_value; END IF;
 INSERT INTO app.integration_encryption_keys(key_label,fingerprint) VALUES(label,digest)
 ON CONFLICT(key_label) DO NOTHING;
 SELECT k.reservations,k.fingerprint INTO used,saved FROM app.integration_encryption_keys k
 WHERE k.key_label=label FOR UPDATE;
 IF saved IS DISTINCT FROM digest THEN RAISE invalid_parameter_value; END IF;
 IF used>=16777216 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='Integration encryption budget exhausted'; END IF;
 UPDATE app.integration_encryption_keys k SET reservations=k.reservations+1 WHERE k.key_label=label;
 RETURN gen_random_uuid();
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.integration_encryption_reserve(uuid,uuid,uuid,text,bytea) FROM PUBLIC;

-- A separate transaction rechecks current access after reservation commits and
-- holds the shared lifecycle lock while Go encrypts. It returns no account ID.
-- +goose StatementBegin
CREATE FUNCTION app.integration_encryption_binding(actor uuid,client uuid,connection uuid)
RETURNS TABLE(client_id uuid,connection_id uuid,provider text,revision bigint,generation bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR
 NOT app.authorization_allowed(actor,'integrations.manage',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients c WHERE c.id=client AND c.archived_at IS NULL) THEN RAISE no_data_found; END IF;
 RETURN QUERY SELECT c.client_id,c.id,c.provider,c.revision,c.generation FROM app.integration_connections c
 WHERE c.id=connection AND c.client_id=client AND c.provider='meta_ads'
 AND c.state IN ('pending','connected','reauthorization_required');
 IF NOT FOUND THEN RAISE no_data_found; END IF;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.integration_encryption_binding(uuid,uuid,uuid) FROM PUBLIC;

-- +goose Down
SELECT pg_advisory_xact_lock(871092650209);
LOCK TABLE app.integration_encryption_keys,app.audit_events IN ACCESS EXCLUSIVE MODE;
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM app.integration_encryption_keys) OR
 EXISTS(SELECT 1 FROM app.audit_events WHERE resource_kind='integration_encryption') THEN
  RAISE EXCEPTION 'Rollback refused: encryption accounting or reservation audit history exists';
 END IF;
END; $$;
-- +goose StatementEnd
DROP FUNCTION app.integration_encryption_binding(uuid,uuid,uuid);
DROP FUNCTION app.integration_encryption_reserve(uuid,uuid,uuid,text,bytea);
DROP TABLE app.integration_encryption_keys;
DROP FUNCTION app.integration_encryption_history_guard();
