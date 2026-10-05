-- +goose Up
-- Legacy profile URL remains byte-preserved for compatibility and recovery.
CREATE TABLE app.client_websites (
 id uuid PRIMARY KEY CHECK(id<>'00000000-0000-0000-0000-000000000000'::uuid),
 client_id uuid NOT NULL REFERENCES app.clients(id),
 name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 200 AND name=btrim(name) AND name!~'[[:cntrl:]]'),
 url text NOT NULL CHECK(char_length(url) BETWEEN 1 AND 2048 AND url!~'[[:cntrl:]]'),
 domain text NOT NULL CHECK(char_length(domain)<=253 AND domain=lower(domain) AND domain!~'[[:cntrl:]]'),
 description text NOT NULL DEFAULT '' CHECK(char_length(description)<=4000 AND description!~'[[:cntrl:]]'),
 is_primary boolean NOT NULL DEFAULT false,
 needs_review boolean NOT NULL DEFAULT false,
 legacy_source boolean NOT NULL DEFAULT false,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 archived_at timestamptz,
 UNIQUE(id,client_id),
 CHECK(updated_at>=created_at AND (archived_at IS NULL OR archived_at>=created_at)),
 CHECK(NOT is_primary OR (archived_at IS NULL AND NOT needs_review)),
 CHECK(needs_review OR (url~'^https?://' AND domain~'^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'))
);
CREATE INDEX client_websites_client ON app.client_websites(client_id,id);
CREATE UNIQUE INDEX client_websites_primary ON app.client_websites(client_id) WHERE is_primary AND archived_at IS NULL;
CREATE UNIQUE INDEX client_websites_legacy ON app.client_websites(client_id) WHERE legacy_source;
CREATE UNIQUE INDEX client_websites_active_url ON app.client_websites(client_id,url) WHERE archived_at IS NULL AND NOT needs_review;
-- Migration accepts only a conservative hostname-only legacy syntax. Other values
-- stay exactly intact for explicit review, rather than inventing normalization.
INSERT INTO app.client_websites(id,client_id,name,url,domain,is_primary,needs_review,legacy_source,created_at,updated_at,archived_at)
 SELECT gen_random_uuid(),id,name,website,
 CASE WHEN website~'^https?://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?/?$' THEN lower(regexp_replace(regexp_replace(website,'^https?://',''),'/$','')) ELSE '' END,
 archived_at IS NULL AND website~'^https?://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?/?$',
 website!~'^https?://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?/?$',true,created_at,updated_at,archived_at
 FROM app.clients WHERE website<>'';

-- A nullable association does not change provider/client/connection identity or
-- ciphertext AAD. Existing integrations remain unassigned, never guessed.
ALTER TABLE app.integration_connections ADD CONSTRAINT integration_connection_client_identity UNIQUE(id,client_id);
CREATE TABLE app.website_integrations (
 connection_id uuid PRIMARY KEY,
 website_id uuid NOT NULL,
 client_id uuid NOT NULL,
 FOREIGN KEY(website_id,client_id) REFERENCES app.client_websites(id,client_id),
 FOREIGN KEY(connection_id,client_id) REFERENCES app.integration_connections(id,client_id)
);
CREATE INDEX website_integrations_website ON app.website_integrations(website_id,connection_id);

-- +goose StatementBegin
CREATE FUNCTION app.website_document(target uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',w.id,'client_id',w.client_id,'name',w.name,'url',w.url,'domain',w.domain,
 'description',w.description,'is_primary',w.is_primary,'needs_review',w.needs_review,
 'status',CASE WHEN w.archived_at IS NULL THEN 'active' ELSE 'archived' END,'revision',w.revision,
 'created_at',w.created_at,'updated_at',w.updated_at,'archived_at',w.archived_at)
 FROM app.client_websites w WHERE w.id=target;
$$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.website_list(actor uuid,client uuid,after_id uuid,page_limit integer,state text) RETURNS SETOF jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR NOT EXISTS(SELECT 1 FROM app.clients WHERE id=client) THEN RAISE no_data_found; END IF;
 IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 101 OR state IS NULL OR state NOT IN ('active','archived','all') THEN RAISE invalid_parameter_value; END IF;
 RETURN QUERY SELECT app.website_document(w.id) FROM app.client_websites w WHERE w.client_id=client
 AND (after_id IS NULL OR w.id>after_id) AND (state='all' OR (state='active' AND w.archived_at IS NULL) OR (state='archived' AND w.archived_at IS NOT NULL))
 ORDER BY w.id LIMIT page_limit;
END; $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.website_read(actor uuid,client uuid,target uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR NOT EXISTS(SELECT 1 FROM app.client_websites WHERE id=target AND client_id=client) THEN RETURN NULL; END IF;
 RETURN app.website_document(target);
END; $$;
-- +goose StatementEnd
-- Returns safe changed-record markers for one atomic multi-event audit.
-- +goose StatementBegin
CREATE FUNCTION app.website_write(actor uuid,client uuid,target uuid,expected bigint,operation text,profile jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE current app.client_websites%ROWTYPE; previous app.client_websites%ROWTYPE; changes jsonb:='[]'::jsonb; permission text;
BEGIN
 PERFORM pg_advisory_xact_lock(871092650209);
 permission:=CASE WHEN operation='archive' THEN 'clients.archive' ELSE 'clients.update' END;
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR NOT app.authorization_allowed(actor,permission,client) OR NOT EXISTS(SELECT 1 FROM app.clients WHERE id=client) THEN RETURN jsonb_build_object('code','missing'); END IF;
 IF NOT EXISTS(SELECT 1 FROM app.clients WHERE id=client AND archived_at IS NULL) THEN RETURN jsonb_build_object('code','conflict'); END IF;
 IF operation IS NULL OR operation NOT IN ('create','update','archive','primary') OR expected IS NULL OR expected<0 OR expected>=9223372036854775807 THEN RETURN jsonb_build_object('code','invalid'); END IF;
 IF operation='create' THEN
  IF expected<>0 THEN RETURN jsonb_build_object('code','invalid'); END IF;
 ELSE
  SELECT * INTO current FROM app.client_websites WHERE id=target AND client_id=client FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('code','missing'); END IF;
  IF current.revision<>expected OR current.archived_at IS NOT NULL THEN RETURN jsonb_build_object('code','conflict'); END IF;
 END IF;
 IF operation IN ('create','update') THEN
  IF profile IS NULL OR jsonb_typeof(profile)<>'object' OR profile-ARRAY['name','url','domain','description']<>'{}'::jsonb OR
  jsonb_typeof(profile->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(profile->'url') IS DISTINCT FROM 'string' OR
  jsonb_typeof(profile->'domain') IS DISTINCT FROM 'string' OR jsonb_typeof(profile->'description') IS DISTINCT FROM 'string' THEN RETURN jsonb_build_object('code','invalid'); END IF;
  IF operation='create' THEN
   INSERT INTO app.client_websites(id,client_id,name,url,domain,description) VALUES(target,client,profile->>'name',profile->>'url',profile->>'domain',profile->>'description');
  ELSE
   UPDATE app.client_websites SET name=profile->>'name',url=profile->>'url',domain=profile->>'domain',description=profile->>'description',needs_review=false,revision=revision+1,updated_at=clock_timestamp() WHERE id=target;
  END IF;
 ELSIF operation='archive' THEN
  UPDATE app.client_websites SET is_primary=false,archived_at=clock_timestamp(),updated_at=clock_timestamp(),revision=revision+1 WHERE id=target;
 ELSE
  IF current.needs_review THEN RETURN jsonb_build_object('code','invalid'); END IF;
  SELECT * INTO previous FROM app.client_websites WHERE client_id=client AND is_primary AND id<>target FOR UPDATE;
  IF FOUND THEN
   IF previous.revision>=9223372036854775807 THEN RETURN jsonb_build_object('code','conflict'); END IF;
   UPDATE app.client_websites SET is_primary=false,revision=revision+1,updated_at=clock_timestamp() WHERE id=previous.id;
   changes:=changes||jsonb_build_array(jsonb_build_object('id',previous.id,'before',previous.revision,'after',previous.revision+1,'action','updated'));
  END IF;
  UPDATE app.client_websites SET is_primary=true,revision=revision+1,updated_at=clock_timestamp() WHERE id=target;
 END IF;
 RETURN jsonb_build_object('code','ok','changes',changes||jsonb_build_array(jsonb_build_object('id',target,'before',expected,'after',expected+1,'action',CASE operation WHEN 'create' THEN 'created' WHEN 'archive' THEN 'archived' ELSE 'updated' END)));
EXCEPTION WHEN check_violation OR not_null_violation OR invalid_text_representation THEN RETURN jsonb_build_object('code','invalid');
 WHEN unique_violation THEN RETURN jsonb_build_object('code','conflict');
END; $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.website_connections(actor uuid,client uuid,website uuid,after_id uuid,page_limit integer) RETURNS SETOF jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR
 NOT (app.authorization_allowed(actor,'integrations.view',client) OR app.authorization_allowed(actor,'analytics.view',client)) OR
 NOT EXISTS(SELECT 1 FROM app.client_websites WHERE id=website AND client_id=client) THEN RAISE no_data_found; END IF;
 IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 101 THEN RAISE invalid_parameter_value; END IF;
 RETURN QUERY SELECT jsonb_build_object('id',c.id,'client_id',c.client_id,'provider',c.provider,'state',c.state,'revision',c.revision::text,'created_at',to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'updated_at',to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
 FROM app.integration_connections c JOIN app.website_integrations b ON b.connection_id=c.id
 WHERE c.client_id=client AND b.client_id=client AND b.website_id=website AND (after_id IS NULL OR c.id>after_id)
 ORDER BY c.id LIMIT page_limit;
END; $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.website_connection_binding(actor uuid,client uuid,website uuid,connection uuid,expected bigint,attach boolean) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(871092650209);
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR NOT app.authorization_allowed(actor,'integrations.manage',client) OR
 NOT EXISTS(SELECT 1 FROM app.client_websites w JOIN app.clients c ON c.id=w.client_id WHERE w.id=website_connection_binding.website AND w.client_id=client AND w.archived_at IS NULL AND c.archived_at IS NULL) OR
 NOT EXISTS(SELECT 1 FROM app.integration_connections WHERE id=connection AND client_id=client) THEN RETURN 'missing'; END IF;
 IF expected IS NULL OR expected<1 OR attach IS NULL THEN RETURN 'invalid'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.client_websites WHERE id=website AND revision=expected) THEN RETURN 'conflict'; END IF;
 IF attach THEN
  IF EXISTS(SELECT 1 FROM app.website_integrations WHERE connection_id=connection) THEN RETURN 'conflict'; END IF;
  INSERT INTO app.website_integrations VALUES(connection,website,client);
 ELSE
  DELETE FROM app.website_integrations WHERE connection_id=connection AND website_id=website AND client_id=client;
  IF NOT FOUND THEN RETURN 'conflict'; END IF;
 END IF;
 UPDATE app.client_websites SET revision=revision+1,updated_at=clock_timestamp() WHERE id=website;
 RETURN 'ok';
END; $$;
-- +goose StatementEnd
-- The actual provider handler still independently enforces its original grants.
-- +goose StatementBegin
CREATE FUNCTION app.website_connection_allowed(actor uuid,client uuid,website uuid,connection uuid,mutation boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 RETURN app.authorization_allowed(actor,'clients.view',client) AND
 EXISTS(SELECT 1 FROM app.website_integrations b JOIN app.integration_connections c ON c.id=b.connection_id
 WHERE b.client_id=client AND b.website_id=website AND b.connection_id=connection AND c.client_id=client) AND
 (NOT mutation OR EXISTS(SELECT 1 FROM app.client_websites w JOIN app.clients c ON c.id=w.client_id WHERE w.id=website_connection_allowed.website AND w.client_id=client AND w.archived_at IS NULL AND c.archived_at IS NULL));
END; $$;
-- +goose StatementEnd
REVOKE ALL ON app.client_websites,app.website_integrations FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.website_document(uuid),app.website_list(uuid,uuid,uuid,integer,text),app.website_read(uuid,uuid,uuid),
 app.website_write(uuid,uuid,uuid,bigint,text,jsonb),app.website_connections(uuid,uuid,uuid,uuid,integer),
 app.website_connection_binding(uuid,uuid,uuid,uuid,bigint,boolean),app.website_connection_allowed(uuid,uuid,uuid,uuid,boolean) FROM PUBLIC;

-- +goose StatementBegin
CREATE FUNCTION app.website_legacy_create() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.website<>'' THEN
 INSERT INTO app.client_websites(id,client_id,name,url,domain,is_primary,needs_review,legacy_source)
 VALUES(gen_random_uuid(),NEW.id,NEW.name,NEW.website,
 CASE WHEN NEW.website~'^https?://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?/?$' THEN lower(regexp_replace(regexp_replace(NEW.website,'^https?://',''),'/$','')) ELSE '' END,
 NEW.website~'^https?://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?/?$',NEW.website!~'^https?://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?/?$',true);
 END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.website_legacy_create() FROM PUBLIC;
CREATE TRIGGER website_legacy_create AFTER INSERT ON app.clients FOR EACH ROW EXECUTE FUNCTION app.website_legacy_create();

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.activity_list(actor uuid,client uuid,after_time timestamptz,after_id uuid,page_limit integer)
RETURNS TABLE(id uuid,client_id uuid,occurred_at timestamptz,event_type text,resource_kind text,resource_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE task_access boolean; planning_access boolean; reminder_access boolean;
BEGIN
 IF NOT app.authorization_allowed(actor,'activity.view',client) OR
 NOT app.authorization_allowed(actor,'clients.view',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients c WHERE c.id=client) THEN RAISE no_data_found; END IF;
 IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 101 OR
 (after_time IS NULL)<>(after_id IS NULL) OR after_id='00000000-0000-0000-0000-000000000000'::uuid OR
 (after_time IS NOT NULL AND (NOT isfinite(after_time) OR after_time<TIMESTAMPTZ '0001-01-01 00:00:00+00' OR after_time>=TIMESTAMPTZ '10000-01-01 00:00:00+00')) THEN RAISE invalid_parameter_value; END IF;
 task_access:=app.authorization_allowed(actor,'tasks.view',client);
 planning_access:=app.authorization_allowed(actor,'planning.view',client);
 reminder_access:=app.authorization_allowed(actor,'reminders.view',client);
 RETURN QUERY SELECT e.id,e.client_id,e.occurred_at,e.event_name,e.resource_kind,e.resource_id
 FROM app.audit_events e
 WHERE e.client_id=client AND e.schema_version=1 AND
 ((e.resource_kind='website' AND e.event_name IN ('website.created','website.updated','website.archived')) OR
  (e.resource_kind='client' AND e.event_name IN ('client.created','client.updated','client.archived')) OR
  (task_access AND e.resource_kind='task' AND e.event_name IN ('task.created','task.updated','task.archived','task.completed','task.cancelled')) OR
  (planning_access AND e.resource_kind='plan' AND e.event_name IN ('plan.created','plan.updated','plan.archived')) OR
  (planning_access AND e.resource_kind='milestone' AND e.event_name IN ('milestone.created','milestone.updated','milestone.archived')) OR
  (reminder_access AND e.resource_kind='reminder' AND e.event_name IN ('reminder.created','reminder.updated','reminder.completed','reminder.dismissed'))) AND
 (after_time IS NULL OR (e.occurred_at,e.id)<(after_time,after_id))
 ORDER BY e.occurred_at DESC,e.id DESC LIMIT page_limit;
END; $$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION app.website_activity(actor uuid,client uuid,website uuid,after_id uuid,page_limit integer) RETURNS SETOF jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE after_time timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR NOT app.authorization_allowed(actor,'activity.view',client) OR
 NOT EXISTS(SELECT 1 FROM app.client_websites WHERE id=website AND client_id=client) THEN RAISE no_data_found; END IF;
 IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 101 THEN RAISE invalid_parameter_value; END IF;
 IF after_id IS NOT NULL THEN SELECT occurred_at INTO after_time FROM app.audit_events WHERE id=after_id AND client_id=client AND resource_kind='website' AND resource_id=website;
 IF NOT FOUND THEN RAISE invalid_parameter_value; END IF; END IF;
 RETURN QUERY SELECT jsonb_build_object('id',e.id,'client_id',e.client_id,'occurred_at',to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'event_type',e.event_name,'resource_kind','website','resource_id',e.resource_id,'summary',CASE e.event_name WHEN 'website.created' THEN 'Website created.' WHEN 'website.updated' THEN 'Website updated.' ELSE 'Website archived.' END)
 FROM app.audit_events e WHERE e.client_id=client AND e.resource_kind='website' AND e.resource_id=website AND e.event_name IN ('website.created','website.updated','website.archived')
 AND (after_id IS NULL OR (e.occurred_at,e.id)<(after_time,after_id)) ORDER BY e.occurred_at DESC,e.id DESC LIMIT page_limit;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.website_activity(uuid,uuid,uuid,uuid,integer) FROM PUBLIC;

-- +goose StatementBegin
CREATE FUNCTION app.website_legacy_marker(actor uuid,client uuid) RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT w.id FROM app.client_websites w WHERE w.client_id=client AND w.legacy_source AND app.authorization_allowed(actor,'clients.create',NULL);
$$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.website_legacy_marker(uuid,uuid) FROM PUBLIC;

-- +goose Down
LOCK TABLE app.client_websites,app.website_integrations IN ACCESS EXCLUSIVE MODE;
-- Refuse rollback after independent records, binding or website audit history.
-- Untouched migrated rows can be dropped because every original byte remains in clients.website.
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM app.client_websites WHERE NOT legacy_source OR revision<>1) OR
 EXISTS(SELECT 1 FROM app.website_integrations) OR EXISTS(SELECT 1 FROM app.audit_events WHERE resource_kind='website') THEN
 RAISE EXCEPTION 'Rollback refused: website history is not empty'; END IF;
END; $$;
-- +goose StatementEnd
DROP TRIGGER website_legacy_create ON app.clients;
DROP FUNCTION app.website_legacy_create(),app.website_legacy_marker(uuid,uuid);
DROP FUNCTION app.website_list(uuid,uuid,uuid,integer,text),app.website_read(uuid,uuid,uuid),app.website_write(uuid,uuid,uuid,bigint,text,jsonb),
 app.website_connections(uuid,uuid,uuid,uuid,integer),app.website_connection_binding(uuid,uuid,uuid,uuid,bigint,boolean),app.website_connection_allowed(uuid,uuid,uuid,uuid,boolean);
DROP FUNCTION app.website_document(uuid),app.website_activity(uuid,uuid,uuid,uuid,integer);
DROP TABLE app.website_integrations,app.client_websites;
ALTER TABLE app.integration_connections DROP CONSTRAINT integration_connection_client_identity;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.activity_list(actor uuid,client uuid,after_time timestamptz,after_id uuid,page_limit integer)
RETURNS TABLE(id uuid,client_id uuid,occurred_at timestamptz,event_type text,resource_kind text,resource_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE task_access boolean; planning_access boolean; reminder_access boolean;
BEGIN
 IF NOT app.authorization_allowed(actor,'activity.view',client) OR
 NOT app.authorization_allowed(actor,'clients.view',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients c WHERE c.id=client) THEN RAISE no_data_found; END IF;
 IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 101 OR
 (after_time IS NULL)<>(after_id IS NULL) OR after_id='00000000-0000-0000-0000-000000000000'::uuid OR
 (after_time IS NOT NULL AND (NOT isfinite(after_time) OR after_time<TIMESTAMPTZ '0001-01-01 00:00:00+00' OR after_time>=TIMESTAMPTZ '10000-01-01 00:00:00+00')) THEN RAISE invalid_parameter_value; END IF;
 task_access:=app.authorization_allowed(actor,'tasks.view',client);
 planning_access:=app.authorization_allowed(actor,'planning.view',client);
 reminder_access:=app.authorization_allowed(actor,'reminders.view',client);
 RETURN QUERY SELECT e.id,e.client_id,e.occurred_at,e.event_name,e.resource_kind,e.resource_id
 FROM app.audit_events e
 WHERE e.client_id=client AND e.schema_version=1 AND
 ((e.resource_kind='client' AND e.event_name IN ('client.created','client.updated','client.archived')) OR
  (task_access AND e.resource_kind='task' AND e.event_name IN ('task.created','task.updated','task.archived','task.completed','task.cancelled')) OR
  (planning_access AND e.resource_kind='plan' AND e.event_name IN ('plan.created','plan.updated','plan.archived')) OR
  (planning_access AND e.resource_kind='milestone' AND e.event_name IN ('milestone.created','milestone.updated','milestone.archived')) OR
  (reminder_access AND e.resource_kind='reminder' AND e.event_name IN ('reminder.created','reminder.updated','reminder.completed','reminder.dismissed'))) AND
 (after_time IS NULL OR (e.occurred_at,e.id)<(after_time,after_id))
 ORDER BY e.occurred_at DESC,e.id DESC LIMIT page_limit;
END; $$;
-- +goose StatementEnd
