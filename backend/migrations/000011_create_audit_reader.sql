-- +goose Up
CREATE INDEX audit_events_time ON app.audit_events(occurred_at DESC,id DESC);

-- New storage keys never expand this read projection.
-- +goose StatementBegin
CREATE FUNCTION app.audit_reader_snapshot(value jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
 SELECT CASE WHEN value='null'::jsonb THEN 'null'::jsonb ELSE jsonb_strip_nulls(jsonb_build_object(
 'exists',value->'exists','revision',value->'revision','status',value->'status',
 'task_status',value->'task_status','planning_status',value->'planning_status',
 'reminder_status',value->'reminder_status','reminder_scheduled_at',value->'reminder_scheduled_at',
 'reminder_timezone',value->'reminder_timezone')) END;
$$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.audit_reader_snapshot(jsonb) FROM PUBLIC;

-- +goose StatementBegin
CREATE FUNCTION app.audit_reader_list(actor uuid,scope_client uuid,filter_client uuid,filter_actor uuid,
 filter_actor_kind text,filter_event text,filter_kind text,filter_resource uuid,filter_request text,
 from_time timestamptz,to_time timestamptz,after_time timestamptz,after_id uuid,page_limit integer)
RETURNS TABLE(id uuid,schema_version smallint,occurred_at timestamptz,actor_kind text,actor_user_id uuid,
 event_type text,resource_kind text,resource_id uuid,client_id uuid,request_id text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE selected_client uuid;
BEGIN
 IF NOT app.authorization_allowed(actor,'audit.view',NULL) THEN
 IF scope_client IS NOT NULL THEN RAISE no_data_found; END IF;
 RAISE EXCEPTION 'Audit access denied' USING ERRCODE='P0001'; END IF;
 IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 101 OR
 scope_client='00000000-0000-0000-0000-000000000000'::uuid OR
 filter_client='00000000-0000-0000-0000-000000000000'::uuid OR
 filter_actor='00000000-0000-0000-0000-000000000000'::uuid OR
 filter_resource='00000000-0000-0000-0000-000000000000'::uuid OR
 (scope_client IS NOT NULL AND filter_client IS NOT NULL AND scope_client<>filter_client) OR
 (filter_actor_kind IS NOT NULL AND filter_actor_kind NOT IN ('system','user')) OR
 (filter_event IS NOT NULL AND filter_event !~ '^[a-z][a-z0-9_]{0,31}\.(created|updated|archived|deleted|disabled|permission_changed|completed|cancelled|dismissed)$') OR
 (filter_kind IS NOT NULL AND filter_kind !~ '^[a-z][a-z0-9_]{0,31}$') OR
 (filter_request IS NOT NULL AND filter_request !~ '^[A-Z2-7]{26}$') OR
 (after_time IS NULL)<>(after_id IS NULL) OR after_id='00000000-0000-0000-0000-000000000000'::uuid OR
 (from_time IS NOT NULL AND (NOT isfinite(from_time) OR from_time<TIMESTAMPTZ '0001-01-01 00:00:00+00' OR from_time>=TIMESTAMPTZ '10000-01-01 00:00:00+00')) OR
 (to_time IS NOT NULL AND (NOT isfinite(to_time) OR to_time<TIMESTAMPTZ '0001-01-01 00:00:00+00' OR to_time>=TIMESTAMPTZ '10000-01-01 00:00:00+00')) OR
 (after_time IS NOT NULL AND (NOT isfinite(after_time) OR after_time<TIMESTAMPTZ '0001-01-01 00:00:00+00' OR after_time>=TIMESTAMPTZ '10000-01-01 00:00:00+00')) OR
 (from_time IS NOT NULL AND to_time IS NOT NULL AND from_time>=to_time) THEN RAISE invalid_parameter_value; END IF;
 selected_client:=COALESCE(scope_client,filter_client);
 IF selected_client IS NOT NULL AND (NOT app.authorization_allowed(actor,'clients.view',selected_client) OR
 NOT EXISTS(SELECT 1 FROM app.clients c WHERE c.id=selected_client)) THEN RAISE no_data_found; END IF;
 RETURN QUERY WITH client_grants AS MATERIALIZED (
 SELECT g.scope_kind,g.client_id FROM app.authorization_grants(actor) g WHERE g.permission_key='clients.view')
 SELECT e.id,e.schema_version,e.occurred_at,e.actor_kind,e.actor_user_id,e.event_name,e.resource_kind,e.resource_id,e.client_id,e.request_id
 FROM app.audit_events e WHERE e.schema_version=1 AND
 (e.client_id IS NULL OR EXISTS(SELECT 1 FROM app.clients c WHERE c.id=e.client_id AND
 EXISTS(SELECT 1 FROM client_grants g WHERE g.scope_kind='global' OR g.client_id=e.client_id))) AND
 (selected_client IS NULL OR e.client_id=selected_client) AND
 (filter_actor IS NULL OR e.actor_user_id=filter_actor) AND (filter_actor_kind IS NULL OR e.actor_kind=filter_actor_kind) AND
 (filter_event IS NULL OR e.event_name=filter_event) AND (filter_kind IS NULL OR e.resource_kind=filter_kind) AND
 (filter_resource IS NULL OR e.resource_id=filter_resource) AND (filter_request IS NULL OR e.request_id=filter_request) AND
 (from_time IS NULL OR e.occurred_at>=from_time) AND (to_time IS NULL OR e.occurred_at<to_time) AND
 (after_time IS NULL OR (e.occurred_at,e.id)<(after_time,after_id))
 ORDER BY e.occurred_at DESC,e.id DESC LIMIT page_limit;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.audit_reader_list(uuid,uuid,uuid,uuid,text,text,text,uuid,text,timestamptz,timestamptz,timestamptz,uuid,integer) FROM PUBLIC;

-- +goose StatementBegin
CREATE FUNCTION app.audit_reader_detail(actor uuid,scope_client uuid,event_id uuid)
RETURNS TABLE(id uuid,schema_version smallint,occurred_at timestamptz,actor_kind text,actor_user_id uuid,
 event_type text,resource_kind text,resource_id uuid,client_id uuid,request_id text,before_state jsonb,after_state jsonb,metadata jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT app.authorization_allowed(actor,'audit.view',NULL) THEN
 IF scope_client IS NOT NULL THEN RAISE no_data_found; END IF;
 RAISE EXCEPTION 'Audit access denied' USING ERRCODE='P0001'; END IF;
 IF event_id IS NULL OR event_id='00000000-0000-0000-0000-000000000000'::uuid OR
 scope_client='00000000-0000-0000-0000-000000000000'::uuid THEN RAISE invalid_parameter_value; END IF;
 IF scope_client IS NOT NULL AND (NOT app.authorization_allowed(actor,'clients.view',scope_client) OR
 NOT EXISTS(SELECT 1 FROM app.clients c WHERE c.id=scope_client)) THEN RAISE no_data_found; END IF;
 RETURN QUERY SELECT e.id,e.schema_version,e.occurred_at,e.actor_kind,e.actor_user_id,e.event_name,e.resource_kind,e.resource_id,e.client_id,e.request_id,
 app.audit_reader_snapshot(e.before_state),app.audit_reader_snapshot(e.after_state),jsonb_build_object('source',e.metadata->'source')
 FROM app.audit_events e WHERE e.id=event_id AND e.schema_version=1 AND (scope_client IS NULL OR e.client_id=scope_client) AND
 (e.client_id IS NULL OR (app.authorization_allowed(actor,'clients.view',e.client_id) AND EXISTS(SELECT 1 FROM app.clients c WHERE c.id=e.client_id)));
 IF NOT FOUND THEN RAISE no_data_found; END IF;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.audit_reader_detail(uuid,uuid,uuid) FROM PUBLIC;

-- +goose Down
-- Remove only reader objects, preserving all populated business/audit/grant history.
DROP FUNCTION app.audit_reader_detail(uuid,uuid,uuid);
DROP FUNCTION app.audit_reader_list(uuid,uuid,uuid,uuid,text,text,text,uuid,text,timestamptz,timestamptz,timestamptz,uuid,integer);
DROP FUNCTION app.audit_reader_snapshot(jsonb);
DROP INDEX app.audit_events_time;
