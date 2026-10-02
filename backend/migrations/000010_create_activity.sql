-- +goose Up
INSERT INTO app.permissions(permission_key,scope_kind,description)
 VALUES ('activity.view','client','View authorized client business activity');
INSERT INTO app.role_permissions(id,role_id,permission_key,seeded)
 VALUES (gen_random_uuid(),'00000000-0000-4000-8000-000000000001','activity.view',true);

-- Read the append-only source directly: no backfill, projection lag or profile
-- joins. The existing audit_events_client_time index supports reverse keysets.
-- +goose StatementBegin
CREATE FUNCTION app.activity_list(actor uuid,client uuid,after_time timestamptz,after_id uuid,page_limit integer)
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
REVOKE EXECUTE ON FUNCTION app.activity_list(uuid,uuid,timestamptz,uuid,integer) FROM PUBLIC;

-- +goose Down
-- Activity stores no new history. Preserve its source and all business records.
LOCK TABLE app.role_permissions,app.permissions IN ACCESS EXCLUSIVE MODE;
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM app.role_permissions WHERE permission_key='activity.view' AND
 (NOT seeded OR revoked_at IS NOT NULL OR role_id<>'00000000-0000-4000-8000-000000000001'::uuid)) THEN
  RAISE EXCEPTION 'Rollback refused: activity permission history is not empty';
 END IF;
END; $$;
-- +goose StatementEnd
DROP FUNCTION app.activity_list(uuid,uuid,timestamptz,uuid,integer);
DELETE FROM app.role_permissions WHERE permission_key='activity.view';
DELETE FROM app.permissions WHERE permission_key='activity.view';
