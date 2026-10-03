-- +goose Up
-- Private encrypted storage only. No provider acceptance or connection success.
-- +goose StatementBegin
CREATE FUNCTION app.integration_credential_envelope_valid(data bytea,label text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE n integer;
BEGIN
 IF data IS NULL OR label IS NULL OR label !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
 OR octet_length(data)<32 OR octet_length(data)>16478 THEN RETURN false; END IF;
 n:=get_byte(data,1);
 RETURN get_byte(data,0)=1 AND n=octet_length(label) AND
  octet_length(data) BETWEEN 2+n+29 AND 2+n+28+16384 AND
  substring(data FROM 3 FOR n)=convert_to(label,'UTF8');
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.integration_credential_envelope_valid(bytea,text) FROM PUBLIC;

CREATE TABLE app.integration_credentials (
 connection_id uuid PRIMARY KEY REFERENCES app.integration_connections(id) ON DELETE RESTRICT,
 purpose text NOT NULL DEFAULT 'access_token' CHECK(purpose='access_token'),
 key_id uuid NOT NULL REFERENCES app.integration_encryption_keys(id) ON DELETE RESTRICT,
 envelope bytea NOT NULL CHECK(octet_length(envelope) BETWEEN 32 AND 16478),
 revision bigint NOT NULL CHECK(revision>0),
 generation bigint NOT NULL CHECK(generation>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
  CHECK(created_at>=TIMESTAMPTZ '0001-01-01 00:00:00+00' AND created_at<TIMESTAMPTZ '10000-01-01 00:00:00+00'),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
  CHECK(updated_at>=created_at AND updated_at<TIMESTAMPTZ '10000-01-01 00:00:00+00')
);
REVOKE ALL ON app.integration_credentials FROM PUBLIC;
CREATE INDEX integration_credentials_key ON app.integration_credentials(key_id,connection_id);

-- Guard owner DML too; admin DDL remains the existing migration trust boundary.
-- +goose StatementBegin
CREATE FUNCTION app.integration_credential_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE label text; used bigint;
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Credential history is retained'; END IF;
 IF TG_OP='UPDATE' AND ((NEW.connection_id,NEW.purpose,NEW.created_at) IS DISTINCT FROM
  (OLD.connection_id,OLD.purpose,OLD.created_at) OR OLD.revision=9223372036854775807 OR
  NEW.revision<>OLD.revision+1 OR NEW.generation<OLD.generation OR NEW.updated_at<OLD.updated_at) THEN
  RAISE EXCEPTION 'Credential identity and revision are immutable';
 END IF;
 SELECT k.key_label,k.reservations INTO label,used FROM app.integration_encryption_keys k WHERE k.id=NEW.key_id;
 IF used IS NULL OR used<1 OR NOT app.integration_credential_envelope_valid(NEW.envelope,label) THEN
  RAISE invalid_parameter_value;
 END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.integration_credential_guard() FROM PUBLIC;
CREATE TRIGGER integration_credential_guard BEFORE INSERT OR UPDATE OR DELETE ON app.integration_credentials
 FOR EACH ROW EXECUTE FUNCTION app.integration_credential_guard();
CREATE TRIGGER integration_credential_truncate BEFORE TRUNCATE ON app.integration_credentials
 FOR EACH STATEMENT EXECUTE FUNCTION app.integration_credential_guard();

-- One internal snapshot; ciphertext never enters a public projection.
-- +goose StatementBegin
CREATE FUNCTION app.integration_credential_read(actor uuid,client uuid,connection uuid)
RETURNS TABLE(connection_revision bigint,connection_generation bigint,credential_revision bigint,
 credential_generation bigint,envelope bytea)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR
 NOT app.authorization_allowed(actor,'integrations.manage',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients c WHERE c.id=client AND c.archived_at IS NULL) THEN RAISE no_data_found; END IF;
 RETURN QUERY SELECT c.revision,c.generation,coalesce(s.revision,0),coalesce(s.generation,0),s.envelope
 FROM app.integration_connections c LEFT JOIN app.integration_credentials s ON s.connection_id=c.id
 WHERE c.id=connection AND c.client_id=client AND c.provider='meta_ads'
 AND c.state IN ('pending','connected','reauthorization_required');
 IF NOT FOUND THEN RAISE no_data_found; END IF;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.integration_credential_read(uuid,uuid,uuid) FROM PUBLIC;

-- Used only by the reviewed typed audited Go writer. Full CAS after crypto.
-- +goose StatementBegin
CREATE FUNCTION app.integration_credential_write(actor uuid,client uuid,connection uuid,
 expected_connection bigint,expected_generation bigint,expected_credential bigint,
 label text,digest bytea,data bytea,rewrap boolean)
RETURNS TABLE(connection_revision bigint,connection_generation bigint,credential_revision bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE c app.integration_connections; s app.integration_credentials; key uuid; now_at timestamptz;
 new_generation bigint; new_revision bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(871092650209);
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR
 NOT app.authorization_allowed(actor,'integrations.manage',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients a WHERE a.id=client AND a.archived_at IS NULL) THEN RAISE no_data_found; END IF;
 SELECT * INTO c FROM app.integration_connections a WHERE a.id=connection AND a.client_id=client
 AND a.provider='meta_ads' AND a.state IN ('pending','connected','reauthorization_required') FOR UPDATE;
 IF NOT FOUND THEN RAISE no_data_found; END IF;
 IF expected_connection IS NULL OR expected_generation IS NULL OR expected_credential IS NULL OR rewrap IS NULL
 OR expected_connection<1 OR expected_generation<1 OR expected_credential<0 OR
 NOT app.integration_credential_envelope_valid(data,label) OR digest IS NULL OR octet_length(digest)<>32 THEN
  RAISE invalid_parameter_value;
 END IF;
 SELECT * INTO s FROM app.integration_credentials a WHERE a.connection_id=connection FOR UPDATE;
 IF (c.revision,c.generation,coalesce(s.revision,0)) IS DISTINCT FROM
 (expected_connection,expected_generation,expected_credential) OR
 (rewrap AND (s.connection_id IS NULL OR s.generation<>c.generation)) OR
 c.revision=9223372036854775807 OR coalesce(s.revision,0)=9223372036854775807 OR
 (NOT rewrap AND c.generation=9223372036854775807) THEN
  RAISE EXCEPTION USING ERRCODE='P0003',MESSAGE='Integration credential revision conflict';
 END IF;
 SELECT k.id INTO key FROM app.integration_encryption_keys k
 WHERE k.key_label=label AND k.fingerprint=digest AND k.reservations>0;
 IF NOT FOUND THEN RAISE invalid_parameter_value; END IF;
 now_at:=greatest(clock_timestamp(),c.updated_at,coalesce(s.updated_at,c.updated_at));
 new_generation:=c.generation+CASE WHEN rewrap THEN 0 ELSE 1 END;
 new_revision:=coalesce(s.revision,0)+1;
 INSERT INTO app.integration_credentials(connection_id,key_id,envelope,revision,generation,created_at,updated_at)
 VALUES(connection,key,data,new_revision,new_generation,now_at,now_at)
 ON CONFLICT(connection_id) DO UPDATE SET key_id=EXCLUDED.key_id,envelope=EXCLUDED.envelope,
 revision=EXCLUDED.revision,generation=EXCLUDED.generation,updated_at=EXCLUDED.updated_at;
 UPDATE app.integration_connections a SET revision=c.revision+1,generation=new_generation,updated_at=now_at
 WHERE a.id=connection;
 RETURN QUERY SELECT c.revision+1,new_generation,new_revision;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.integration_credential_write(uuid,uuid,uuid,bigint,bigint,bigint,text,bytea,bytea,boolean) FROM PUBLIC;

-- +goose Down
SELECT pg_advisory_xact_lock(871092650209);
LOCK TABLE app.integration_credentials,app.audit_events IN ACCESS EXCLUSIVE MODE;
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM app.integration_credentials) OR
 EXISTS(SELECT 1 FROM app.audit_events WHERE resource_kind='integration_credential') THEN
  RAISE EXCEPTION 'Rollback refused: credential or credential audit history exists';
 END IF;
END; $$;
-- +goose StatementEnd
DROP FUNCTION app.integration_credential_write(uuid,uuid,uuid,bigint,bigint,bigint,text,bytea,bytea,boolean);
DROP FUNCTION app.integration_credential_read(uuid,uuid,uuid);
DROP TABLE app.integration_credentials;
DROP FUNCTION app.integration_credential_guard();
DROP FUNCTION app.integration_credential_envelope_valid(bytea,text);
