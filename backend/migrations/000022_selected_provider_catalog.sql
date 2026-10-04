-- +goose Up
-- Expand private catalog only; no public setup, provider traffic or success seed.
SELECT pg_advisory_xact_lock(871092650209);
LOCK TABLE app.integration_connections,app.integration_credentials,app.audit_events IN ACCESS EXCLUSIVE MODE;

-- Syntax only. Destination/ownership verification belongs to future transport.
-- +goose StatementBegin
CREATE FUNCTION app.integration_account_valid(provider text,account text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE host text; tail text; part text;
BEGIN
 IF provider IS NULL OR account IS NULL THEN RETURN false; END IF;
 IF provider='meta_ads' THEN RETURN account COLLATE "C" ~ '^[1-9][0-9]{0,31}$'; END IF;
 IF provider='ga4' THEN RETURN account COLLATE "C" ~ '^[1-9][0-9]{0,19}$'; END IF;
 IF provider<>'woocommerce' OR octet_length(account)>520 OR
  account COLLATE "C" !~ '^https://[a-z0-9.-]+(/[A-Za-z0-9_-]+)*$' THEN RETURN false; END IF;
 host:=split_part(substring(account FROM 9),'/',1);
 tail:=substring(account FROM 9+length(host));
 IF length(host)>253 OR length(tail)>256 OR position('.' IN host)=0 THEN RETURN false; END IF;
 FOREACH part IN ARRAY string_to_array(host,'.') LOOP
  IF length(part) NOT BETWEEN 1 AND 63 OR part COLLATE "C" !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' THEN RETURN false; END IF;
 END LOOP;
 -- Alphabetic TLD start rejects direct numeric/IPv4 hosts; IPv6 fails above.
 part:=split_part(host,'.',-1);
 RETURN part COLLATE "C" ~ '^[a-z][a-z0-9-]*[a-z0-9]$';
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.integration_account_valid(text,text) FROM PUBLIC;

ALTER TABLE app.integration_connections DROP CONSTRAINT integration_connections_provider_check,
 DROP CONSTRAINT integration_connections_provider_account_id_check;
ALTER TABLE app.integration_connections ADD CONSTRAINT integration_connections_provider_check
 CHECK(provider IN ('meta_ads','ga4','woocommerce')),
 ADD CONSTRAINT integration_connections_provider_account_id_check CHECK(app.integration_account_valid(provider,provider_account_id));
ALTER TABLE app.integration_credentials DROP CONSTRAINT integration_credentials_purpose_check;
ALTER TABLE app.integration_credentials ADD CONSTRAINT integration_credentials_purpose_check
 CHECK(purpose IN ('access_token','provider_credential'));

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.integration_encryption_reserve(actor uuid,client uuid,connection uuid,label text,digest bytea)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE used bigint; saved bytea;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR
 NOT app.authorization_allowed(actor,'integrations.manage',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients c WHERE c.id=client AND c.archived_at IS NULL) OR
 NOT EXISTS(SELECT 1 FROM app.integration_connections c WHERE c.id=connection AND c.client_id=client
  AND c.provider IN ('meta_ads','ga4','woocommerce') AND c.state IN ('pending','connected','reauthorization_required')) THEN RAISE no_data_found; END IF;
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

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.integration_encryption_binding(actor uuid,client uuid,connection uuid)
RETURNS TABLE(client_id uuid,connection_id uuid,provider text,revision bigint,generation bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR
 NOT app.authorization_allowed(actor,'integrations.manage',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients c WHERE c.id=client AND c.archived_at IS NULL) THEN RAISE no_data_found; END IF;
 RETURN QUERY SELECT c.client_id,c.id,c.provider,c.revision,c.generation FROM app.integration_connections c
 WHERE c.id=connection AND c.client_id=client AND c.provider IN ('meta_ads','ga4','woocommerce')
 AND c.state IN ('pending','connected','reauthorization_required');
 IF NOT FOUND THEN RAISE no_data_found; END IF;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.integration_encryption_binding(uuid,uuid,uuid) FROM PUBLIC;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.integration_credential_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE label text; used bigint;
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Credential history is retained'; END IF;
 IF TG_OP='UPDATE' AND ((NEW.connection_id,NEW.purpose,NEW.created_at) IS DISTINCT FROM
  (OLD.connection_id,OLD.purpose,OLD.created_at) OR OLD.revision=9223372036854775807 OR
  NEW.revision<>OLD.revision+1 OR NEW.generation<OLD.generation OR NEW.updated_at<OLD.updated_at) THEN
  RAISE EXCEPTION 'Credential identity and revision are immutable';
 END IF;
 IF NEW.purpose IS DISTINCT FROM (SELECT CASE c.provider WHEN 'meta_ads' THEN 'access_token'
  WHEN 'ga4' THEN 'provider_credential' WHEN 'woocommerce' THEN 'provider_credential' END
  FROM app.integration_connections c WHERE c.id=NEW.connection_id) THEN RAISE invalid_parameter_value; END IF;
 SELECT k.key_label,k.reservations INTO label,used FROM app.integration_encryption_keys k WHERE k.id=NEW.key_id;
 IF used IS NULL OR used<1 OR NOT app.integration_credential_envelope_valid(NEW.envelope,label) THEN
  RAISE invalid_parameter_value;
 END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.integration_credential_guard() FROM PUBLIC;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.integration_credential_read(actor uuid,client uuid,connection uuid)
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
 WHERE c.id=connection AND c.client_id=client AND c.provider IN ('meta_ads','ga4','woocommerce')
 AND c.state IN ('pending','connected','reauthorization_required');
 IF NOT FOUND THEN RAISE no_data_found; END IF;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.integration_credential_read(uuid,uuid,uuid) FROM PUBLIC;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.integration_credential_write(actor uuid,client uuid,connection uuid,
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
 AND a.provider IN ('meta_ads','ga4','woocommerce') AND a.state IN ('pending','connected','reauthorization_required') FOR UPDATE;
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
 INSERT INTO app.integration_credentials(connection_id,purpose,key_id,envelope,revision,generation,created_at,updated_at)
 VALUES(connection,CASE c.provider WHEN 'meta_ads' THEN 'access_token' ELSE 'provider_credential' END,key,data,new_revision,new_generation,now_at,now_at)
 ON CONFLICT(connection_id) DO UPDATE SET key_id=EXCLUDED.key_id,envelope=EXCLUDED.envelope,
 revision=EXCLUDED.revision,generation=EXCLUDED.generation,updated_at=EXCLUDED.updated_at;
 UPDATE app.integration_connections a SET revision=c.revision+1,generation=new_generation,updated_at=now_at
 WHERE a.id=connection;
 RETURN QUERY SELECT c.revision+1,new_generation,new_revision;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.integration_credential_write(uuid,uuid,uuid,bigint,bigint,bigint,text,bytea,bytea,boolean) FROM PUBLIC;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.integration_local_disconnect(actor uuid,client uuid,connection uuid,expected bigint)
RETURNS TABLE(id uuid,client_id uuid,provider text,state text,revision bigint,
 created_at timestamptz,updated_at timestamptz,changed boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE c app.integration_connections;
BEGIN
 PERFORM pg_advisory_xact_lock(871092650209);
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR
 NOT app.authorization_allowed(actor,'integrations.view',client) OR
 NOT app.authorization_allowed(actor,'integrations.manage',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients a WHERE a.id=client AND a.archived_at IS NULL) THEN RAISE no_data_found; END IF;
 SELECT * INTO c FROM app.integration_connections a WHERE a.id=connection AND a.client_id=client
 AND a.provider IN ('meta_ads','ga4','woocommerce') FOR UPDATE;
 IF NOT FOUND THEN RAISE no_data_found; END IF;
 IF expected IS NULL OR expected<1 THEN RAISE invalid_parameter_value; END IF;
 IF c.revision<>expected OR c.state='disconnected' THEN
  RAISE EXCEPTION USING ERRCODE='P0003',MESSAGE='Integration disconnect revision conflict';
 END IF;
 IF c.state='revocation_failed' THEN
  RETURN QUERY SELECT c.id,c.client_id,c.provider,c.state,c.revision,c.created_at,c.updated_at,false;
  RETURN;
 END IF;
 IF c.revision=9223372036854775807 OR c.generation=9223372036854775807 THEN
  RAISE EXCEPTION USING ERRCODE='P0003',MESSAGE='Integration disconnect revision conflict';
 END IF;
 UPDATE app.integration_connections a SET state='revocation_failed',revision=c.revision+1,
 generation=c.generation+1,updated_at=greatest(clock_timestamp(),c.updated_at) WHERE a.id=connection
 RETURNING a.* INTO c;
 RETURN QUERY SELECT c.id,c.client_id,c.provider,c.state,c.revision,c.created_at,c.updated_at,true;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.integration_local_disconnect(uuid,uuid,uuid,bigint) FROM PUBLIC;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.integration_rotation_candidates(actor uuid,client uuid,label text,digest bytea,
 after_id uuid,page_size integer)
RETURNS TABLE(connection_id uuid,connection_revision bigint,connection_generation bigint,credential_revision bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR
 NOT app.authorization_allowed(actor,'integrations.manage',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients c WHERE c.id=client AND c.archived_at IS NULL) THEN RAISE no_data_found; END IF;
 IF label IS NULL OR label !~ '^[a-z0-9][a-z0-9_-]{0,63}$' OR digest IS NULL OR
 octet_length(digest)<>32 OR digest=decode(repeat('00',32),'hex') OR page_size IS NULL OR
 page_size NOT BETWEEN 1 AND 100 OR after_id='00000000-0000-0000-0000-000000000000'::uuid THEN
  RAISE invalid_parameter_value;
 END IF;
 IF EXISTS(SELECT 1 FROM app.integration_encryption_keys k
  WHERE (k.key_label=label OR k.fingerprint=digest) AND (k.key_label<>label OR k.fingerprint<>digest)) THEN
  RAISE invalid_parameter_value;
 END IF;
 RETURN QUERY SELECT c.id,c.revision,c.generation,s.revision
 FROM app.integration_connections c JOIN app.integration_credentials s ON s.connection_id=c.id
 JOIN app.integration_encryption_keys k ON k.id=s.key_id
 WHERE c.client_id=client AND c.provider IN ('meta_ads','ga4','woocommerce') AND
 c.state IN ('pending','connected','reauthorization_required') AND s.generation=c.generation AND
 k.fingerprint<>digest AND (after_id IS NULL OR c.id>after_id)
 ORDER BY c.id LIMIT page_size+1;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.integration_rotation_candidates(uuid,uuid,text,bytea,uuid,integer) FROM PUBLIC;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.integration_key_inventory(actor uuid,labels text[],digests bytea[],active_label text,restored boolean)
RETURNS TABLE(key_position integer,is_active boolean,stored_rows bigint,eligible_rows bigint,excluded_rows bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE active_digest bytea;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 IF NOT EXISTS(SELECT 1 FROM app.authorization_grants(actor) g WHERE g.permission_key='clients.view' AND g.scope_kind='global') OR
 NOT EXISTS(SELECT 1 FROM app.authorization_grants(actor) g WHERE g.permission_key='integrations.manage' AND g.scope_kind='global') THEN
  RAISE no_data_found;
 END IF;
 IF labels IS NULL OR digests IS NULL OR active_label IS NULL OR restored IS NULL OR
 array_ndims(labels) IS DISTINCT FROM 1 OR array_ndims(digests) IS DISTINCT FROM 1 OR
 array_lower(labels,1) IS DISTINCT FROM 1 OR array_lower(digests,1) IS DISTINCT FROM 1 OR
 cardinality(labels) NOT BETWEEN 1 AND 8 OR cardinality(labels)<>cardinality(digests) THEN RAISE invalid_parameter_value; END IF;
 IF EXISTS(SELECT 1 FROM unnest(labels,digests) AS supplied(label,digest)
  WHERE label IS NULL OR label !~ '^[a-z0-9][a-z0-9_-]{0,63}$' OR digest IS NULL OR
  octet_length(digest)<>32 OR digest=decode(repeat('00',32),'hex')) OR
 (SELECT count(DISTINCT label) FROM unnest(labels) AS supplied(label))<>cardinality(labels) OR
 (SELECT count(DISTINCT digest) FROM unnest(digests) AS supplied(digest))<>cardinality(digests) OR
 NOT active_label=ANY(labels) THEN RAISE invalid_parameter_value; END IF;
 IF EXISTS(SELECT 1 FROM unnest(labels,digests) AS supplied(label,digest)
  JOIN app.integration_encryption_keys k ON k.key_label=label OR k.fingerprint=digest
  WHERE k.key_label<>label OR k.fingerprint<>digest) OR
 EXISTS(SELECT 1 FROM app.integration_credentials c JOIN app.integration_encryption_keys k ON k.id=c.key_id
  WHERE NOT k.key_label=ANY(labels)) OR
 (restored AND EXISTS(SELECT 1 FROM app.integration_encryption_keys k WHERE k.key_label=active_label)) THEN
  RAISE object_not_in_prerequisite_state;
 END IF;
 SELECT supplied.digest INTO active_digest FROM unnest(labels,digests) AS supplied(label,digest) WHERE supplied.label=active_label;
 RETURN QUERY WITH tally AS (
  SELECT supplied.ordinal::integer AS slot,supplied.key_label=active_label AS active,
   count(s.connection_id) AS total,
   count(s.connection_id) FILTER(WHERE k.fingerprint<>active_digest AND cl.id IS NOT NULL AND cl.archived_at IS NULL AND
    c.provider IN ('meta_ads','ga4','woocommerce') AND c.state IN ('pending','connected','reauthorization_required') AND s.generation=c.generation) AS eligible
  FROM unnest(labels,digests) WITH ORDINALITY AS supplied(key_label,key_digest,ordinal)
  LEFT JOIN app.integration_encryption_keys k ON k.key_label=supplied.key_label AND k.fingerprint=supplied.key_digest
  LEFT JOIN app.integration_credentials s ON s.key_id=k.id
  LEFT JOIN app.integration_connections c ON c.id=s.connection_id
  LEFT JOIN app.clients cl ON cl.id=c.client_id
  GROUP BY supplied.ordinal,supplied.key_label
 ) SELECT tally.slot,tally.active,tally.total,tally.eligible,tally.total-tally.eligible FROM tally ORDER BY tally.slot;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.integration_key_inventory(uuid,text[],bytea[],text,boolean) FROM PUBLIC;
-- +goose Down
SELECT pg_advisory_xact_lock(871092650209);
LOCK TABLE app.integration_connections,app.integration_credentials,app.audit_events IN ACCESS EXCLUSIVE MODE;
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM app.integration_connections WHERE provider<>'meta_ads') OR
 EXISTS(SELECT 1 FROM app.integration_credentials WHERE purpose<>'access_token') OR
 EXISTS(SELECT 1 FROM app.audit_events e LEFT JOIN app.integration_connections c ON c.id=e.resource_id
  WHERE e.resource_kind IN ('integration_connection','integration_credential') AND c.id IS NULL) THEN
  RAISE EXCEPTION 'Rollback refused: selected-provider or unresolved integration history exists';
 END IF;
END; $$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.integration_encryption_reserve(actor uuid,client uuid,connection uuid,label text,digest bytea)
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

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.integration_encryption_binding(actor uuid,client uuid,connection uuid)
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

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.integration_credential_guard() RETURNS trigger
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

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.integration_credential_read(actor uuid,client uuid,connection uuid)
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

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.integration_credential_write(actor uuid,client uuid,connection uuid,
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

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.integration_local_disconnect(actor uuid,client uuid,connection uuid,expected bigint)
RETURNS TABLE(id uuid,client_id uuid,provider text,state text,revision bigint,
 created_at timestamptz,updated_at timestamptz,changed boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE c app.integration_connections;
BEGIN
 PERFORM pg_advisory_xact_lock(871092650209);
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR
 NOT app.authorization_allowed(actor,'integrations.view',client) OR
 NOT app.authorization_allowed(actor,'integrations.manage',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients a WHERE a.id=client AND a.archived_at IS NULL) THEN RAISE no_data_found; END IF;
 SELECT * INTO c FROM app.integration_connections a WHERE a.id=connection AND a.client_id=client
 AND a.provider='meta_ads' FOR UPDATE;
 IF NOT FOUND THEN RAISE no_data_found; END IF;
 IF expected IS NULL OR expected<1 THEN RAISE invalid_parameter_value; END IF;
 IF c.revision<>expected OR c.state='disconnected' THEN
  RAISE EXCEPTION USING ERRCODE='P0003',MESSAGE='Integration disconnect revision conflict';
 END IF;
 IF c.state='revocation_failed' THEN
  RETURN QUERY SELECT c.id,c.client_id,c.provider,c.state,c.revision,c.created_at,c.updated_at,false;
  RETURN;
 END IF;
 IF c.revision=9223372036854775807 OR c.generation=9223372036854775807 THEN
  RAISE EXCEPTION USING ERRCODE='P0003',MESSAGE='Integration disconnect revision conflict';
 END IF;
 UPDATE app.integration_connections a SET state='revocation_failed',revision=c.revision+1,
 generation=c.generation+1,updated_at=greatest(clock_timestamp(),c.updated_at) WHERE a.id=connection
 RETURNING a.* INTO c;
 RETURN QUERY SELECT c.id,c.client_id,c.provider,c.state,c.revision,c.created_at,c.updated_at,true;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.integration_local_disconnect(uuid,uuid,uuid,bigint) FROM PUBLIC;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.integration_rotation_candidates(actor uuid,client uuid,label text,digest bytea,
 after_id uuid,page_size integer)
RETURNS TABLE(connection_id uuid,connection_revision bigint,connection_generation bigint,credential_revision bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR
 NOT app.authorization_allowed(actor,'integrations.manage',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients c WHERE c.id=client AND c.archived_at IS NULL) THEN RAISE no_data_found; END IF;
 IF label IS NULL OR label !~ '^[a-z0-9][a-z0-9_-]{0,63}$' OR digest IS NULL OR
 octet_length(digest)<>32 OR digest=decode(repeat('00',32),'hex') OR page_size IS NULL OR
 page_size NOT BETWEEN 1 AND 100 OR after_id='00000000-0000-0000-0000-000000000000'::uuid THEN
  RAISE invalid_parameter_value;
 END IF;
 IF EXISTS(SELECT 1 FROM app.integration_encryption_keys k
  WHERE (k.key_label=label OR k.fingerprint=digest) AND (k.key_label<>label OR k.fingerprint<>digest)) THEN
  RAISE invalid_parameter_value;
 END IF;
 RETURN QUERY SELECT c.id,c.revision,c.generation,s.revision
 FROM app.integration_connections c JOIN app.integration_credentials s ON s.connection_id=c.id
 JOIN app.integration_encryption_keys k ON k.id=s.key_id
 WHERE c.client_id=client AND c.provider='meta_ads' AND
 c.state IN ('pending','connected','reauthorization_required') AND s.generation=c.generation AND
 k.fingerprint<>digest AND (after_id IS NULL OR c.id>after_id)
 ORDER BY c.id LIMIT page_size+1;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.integration_rotation_candidates(uuid,uuid,text,bytea,uuid,integer) FROM PUBLIC;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.integration_key_inventory(actor uuid,labels text[],digests bytea[],active_label text,restored boolean)
RETURNS TABLE(key_position integer,is_active boolean,stored_rows bigint,eligible_rows bigint,excluded_rows bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE active_digest bytea;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 IF NOT EXISTS(SELECT 1 FROM app.authorization_grants(actor) g WHERE g.permission_key='clients.view' AND g.scope_kind='global') OR
 NOT EXISTS(SELECT 1 FROM app.authorization_grants(actor) g WHERE g.permission_key='integrations.manage' AND g.scope_kind='global') THEN
  RAISE no_data_found;
 END IF;
 IF labels IS NULL OR digests IS NULL OR active_label IS NULL OR restored IS NULL OR
 array_ndims(labels) IS DISTINCT FROM 1 OR array_ndims(digests) IS DISTINCT FROM 1 OR
 array_lower(labels,1) IS DISTINCT FROM 1 OR array_lower(digests,1) IS DISTINCT FROM 1 OR
 cardinality(labels) NOT BETWEEN 1 AND 8 OR cardinality(labels)<>cardinality(digests) THEN RAISE invalid_parameter_value; END IF;
 IF EXISTS(SELECT 1 FROM unnest(labels,digests) AS supplied(label,digest)
  WHERE label IS NULL OR label !~ '^[a-z0-9][a-z0-9_-]{0,63}$' OR digest IS NULL OR
  octet_length(digest)<>32 OR digest=decode(repeat('00',32),'hex')) OR
 (SELECT count(DISTINCT label) FROM unnest(labels) AS supplied(label))<>cardinality(labels) OR
 (SELECT count(DISTINCT digest) FROM unnest(digests) AS supplied(digest))<>cardinality(digests) OR
 NOT active_label=ANY(labels) THEN RAISE invalid_parameter_value; END IF;
 IF EXISTS(SELECT 1 FROM unnest(labels,digests) AS supplied(label,digest)
  JOIN app.integration_encryption_keys k ON k.key_label=label OR k.fingerprint=digest
  WHERE k.key_label<>label OR k.fingerprint<>digest) OR
 EXISTS(SELECT 1 FROM app.integration_credentials c JOIN app.integration_encryption_keys k ON k.id=c.key_id
  WHERE NOT k.key_label=ANY(labels)) OR
 (restored AND EXISTS(SELECT 1 FROM app.integration_encryption_keys k WHERE k.key_label=active_label)) THEN
  RAISE object_not_in_prerequisite_state;
 END IF;
 SELECT supplied.digest INTO active_digest FROM unnest(labels,digests) AS supplied(label,digest) WHERE supplied.label=active_label;
 RETURN QUERY WITH tally AS (
  SELECT supplied.ordinal::integer AS slot,supplied.key_label=active_label AS active,
   count(s.connection_id) AS total,
   count(s.connection_id) FILTER(WHERE k.fingerprint<>active_digest AND cl.id IS NOT NULL AND cl.archived_at IS NULL AND
    c.provider='meta_ads' AND c.state IN ('pending','connected','reauthorization_required') AND s.generation=c.generation) AS eligible
  FROM unnest(labels,digests) WITH ORDINALITY AS supplied(key_label,key_digest,ordinal)
  LEFT JOIN app.integration_encryption_keys k ON k.key_label=supplied.key_label AND k.fingerprint=supplied.key_digest
  LEFT JOIN app.integration_credentials s ON s.key_id=k.id
  LEFT JOIN app.integration_connections c ON c.id=s.connection_id
  LEFT JOIN app.clients cl ON cl.id=c.client_id
  GROUP BY supplied.ordinal,supplied.key_label
 ) SELECT tally.slot,tally.active,tally.total,tally.eligible,tally.total-tally.eligible FROM tally ORDER BY tally.slot;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.integration_key_inventory(uuid,text[],bytea[],text,boolean) FROM PUBLIC;

ALTER TABLE app.integration_credentials DROP CONSTRAINT integration_credentials_purpose_check;
ALTER TABLE app.integration_credentials ADD CONSTRAINT integration_credentials_purpose_check CHECK(purpose='access_token');
ALTER TABLE app.integration_connections DROP CONSTRAINT integration_connections_provider_check,
 DROP CONSTRAINT integration_connections_provider_account_id_check;
ALTER TABLE app.integration_connections ADD CONSTRAINT integration_connections_provider_check CHECK(provider='meta_ads'),
 ADD CONSTRAINT integration_connections_provider_account_id_check CHECK(provider_account_id ~ '^[1-9][0-9]{0,31}$');
DROP FUNCTION app.integration_account_valid(text,text);
