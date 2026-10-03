-- +goose Up
-- Trusted process startup capability: boolean only, never a key registry reader.
-- +goose StatementBegin
CREATE FUNCTION app.integration_key_preflight(labels text[],digests bytea[],active_label text,restored boolean)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 IF labels IS NULL OR digests IS NULL OR active_label IS NULL OR restored IS NULL OR
 array_ndims(labels) IS DISTINCT FROM 1 OR array_ndims(digests) IS DISTINCT FROM 1 OR
 array_lower(labels,1) IS DISTINCT FROM 1 OR array_lower(digests,1) IS DISTINCT FROM 1 OR
 cardinality(labels) NOT BETWEEN 1 AND 8 OR cardinality(labels)<>cardinality(digests) THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM unnest(labels,digests) AS supplied(label,digest)
  WHERE label IS NULL OR label !~ '^[a-z0-9][a-z0-9_-]{0,63}$' OR digest IS NULL OR
  octet_length(digest)<>32 OR digest=decode(repeat('00',32),'hex')) OR
 (SELECT count(DISTINCT label) FROM unnest(labels) AS supplied(label))<>cardinality(labels) OR
 (SELECT count(DISTINCT digest) FROM unnest(digests) AS supplied(digest))<>cardinality(digests) OR
 NOT active_label=ANY(labels) THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM unnest(labels,digests) AS supplied(label,digest)
  JOIN app.integration_encryption_keys k ON k.key_label=label OR k.fingerprint=digest
  WHERE k.key_label<>label OR k.fingerprint<>digest) OR
 EXISTS(SELECT 1 FROM app.integration_credentials c JOIN app.integration_encryption_keys k ON k.id=c.key_id
  WHERE NOT k.key_label=ANY(labels)) OR
 EXISTS(SELECT 1 FROM app.integration_encryption_keys k WHERE k.key_label=active_label
  AND (restored OR k.reservations>=16777216)) THEN RETURN false; END IF;
 RETURN true;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.integration_key_preflight(text[],bytea[],text,boolean) FROM PUBLIC;

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
 PERFORM pg_advisory_xact_lock(871092650209);
 DROP FUNCTION app.integration_key_preflight(text[],bytea[],text,boolean);
END; $$;
-- +goose StatementEnd
