-- +goose Up
-- Private exact-client rotation planning only: no envelope or key projection.
-- +goose StatementBegin
CREATE FUNCTION app.integration_rotation_candidates(actor uuid,client uuid,label text,digest bytea,
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

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
 PERFORM pg_advisory_xact_lock(871092650209);
 DROP FUNCTION app.integration_rotation_candidates(uuid,uuid,text,bytea,uuid,integer);
END; $$;
-- +goose StatementEnd
