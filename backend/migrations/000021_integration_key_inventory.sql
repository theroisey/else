-- +goose Up
-- Trusted live retention observation: source-relative counts, no key identity.
-- +goose StatementBegin
CREATE FUNCTION app.integration_key_inventory(actor uuid,labels text[],digests bytea[],active_label text,restored boolean)
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

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
 PERFORM pg_advisory_xact_lock(871092650209);
 DROP FUNCTION app.integration_key_inventory(uuid,text[],bytea[],text,boolean);
END; $$;
-- +goose StatementEnd
