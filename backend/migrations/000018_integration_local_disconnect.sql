-- +goose Up
-- Local disablement only. No configured provider revoker or remote success.
-- +goose StatementBegin
CREATE FUNCTION app.integration_local_disconnect(actor uuid,client uuid,connection uuid,expected bigint)
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

-- +goose Down
-- Removing an entrypoint never deletes metadata, ciphertext or audit history.
SELECT pg_advisory_xact_lock(871092650209);
DROP FUNCTION app.integration_local_disconnect(uuid,uuid,uuid,bigint);
