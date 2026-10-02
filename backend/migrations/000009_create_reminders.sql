-- +goose Up
INSERT INTO app.permissions(permission_key,scope_kind,description) VALUES
 ('reminders.view','client','View client reminders'),
 ('reminders.create','client','Create client reminders'),
 ('reminders.update','client','Update, complete and dismiss client reminders');
INSERT INTO app.role_permissions(id,role_id,permission_key,seeded)
 SELECT gen_random_uuid(),'00000000-0000-4000-8000-000000000001'::uuid,permission_key,true
 FROM app.permissions WHERE permission_key IN ('reminders.view','reminders.create','reminders.update');

-- Validation is repeated inside the trusted SQL writer, including for direct
-- runtime calls. IANA rule disagreements fail rather than silently moving time.
-- +goose StatementBegin
CREATE FUNCTION app.reminder_schedule_consistent(local_time text,zone text,utc_offset integer,instant timestamptz) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE wall timestamp;
BEGIN
 IF local_time IS NULL OR local_time !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?$' OR
 zone IS NULL OR char_length(zone)>100 OR zone !~ '^(UTC|[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)+)$' OR
 utc_offset IS NULL OR utc_offset NOT BETWEEN -86399 AND 86399 OR
 instant IS NULL OR NOT isfinite(instant) OR instant<TIMESTAMPTZ '0001-01-01 00:00:00+00' OR instant>=TIMESTAMPTZ '10000-01-01 00:00:00+00' THEN RETURN false; END IF;
 wall:=local_time::timestamp;
 IF left(local_time,19)<>to_char(wall,'YYYY-MM-DD"T"HH24:MI:SS') THEN RETURN false; END IF;
 RETURN wall>=TIMESTAMP '0001-01-01' AND wall<TIMESTAMP '10000-01-01' AND
 extract(epoch FROM wall-(instant AT TIME ZONE 'UTC'))=utc_offset;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_parameter_value THEN RETURN false;
END; $$;
-- +goose StatementEnd
-- Keep stored intent valid after timezone rules change; new schedules still
-- need matching current rules in both the Go adapter and guarded SQL writer.
-- +goose StatementBegin
CREATE FUNCTION app.reminder_schedule_valid(local_time text,zone text,utc_offset integer,instant timestamptz) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
BEGIN
 IF NOT app.reminder_schedule_consistent(local_time,zone,utc_offset,instant) OR
 NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=zone) THEN RETURN false; END IF;
 RETURN instant AT TIME ZONE zone=local_time::timestamp;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_parameter_value THEN RETURN false;
END; $$;
-- +goose StatementEnd
CREATE TABLE app.reminders (
 id uuid PRIMARY KEY CHECK(id<>'00000000-0000-0000-0000-000000000000'),
 client_id uuid NOT NULL REFERENCES app.clients(id),
 created_by uuid NOT NULL REFERENCES app.users(id),
 owner_id uuid NOT NULL REFERENCES app.users(id),
 title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 200 AND title=btrim(title) AND title!~'[[:cntrl:]]'),
 description text NOT NULL DEFAULT '' CHECK(char_length(description)<=8000 AND replace(description,E'\n','')!~'[[:cntrl:]]'),
 status text NOT NULL CHECK(status IN ('pending','completed','dismissed')),
 scheduled_at timestamptz NOT NULL,
 scheduled_local text NOT NULL,
 timezone text NOT NULL,
 utc_offset_seconds integer NOT NULL,
 task_id uuid,
 plan_id uuid,
 milestone_id uuid,
 milestone_plan_id uuid,
 completed_at timestamptz,
 dismissed_at timestamptz,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(task_id,client_id) REFERENCES app.tasks(id,client_id),
 FOREIGN KEY(plan_id,client_id) REFERENCES app.plans(id,client_id),
 FOREIGN KEY(milestone_id,milestone_plan_id,client_id) REFERENCES app.milestones(id,plan_id,client_id),
 CHECK(num_nonnulls(task_id,plan_id,milestone_id)<=1),
 CHECK((milestone_id IS NULL)=(milestone_plan_id IS NULL)),
 CHECK(app.reminder_schedule_consistent(scheduled_local,timezone,utc_offset_seconds,scheduled_at)),
 CHECK((status='completed')=(completed_at IS NOT NULL)),
 CHECK((status='dismissed')=(dismissed_at IS NOT NULL)),
 CHECK(updated_at>=created_at AND (completed_at IS NULL OR completed_at>=created_at) AND (dismissed_at IS NULL OR dismissed_at>=created_at))
);
CREATE INDEX reminders_client_id ON app.reminders(client_id,id);
CREATE INDEX reminders_client_status_id ON app.reminders(client_id,status,id);
CREATE INDEX reminders_client_owner_id ON app.reminders(client_id,owner_id,id);
CREATE INDEX reminders_pending_due ON app.reminders(client_id,scheduled_at,id) WHERE status='pending';

-- +goose StatementBegin
CREATE FUNCTION app.reminder_document(target uuid,details boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',r.id,'client_id',r.client_id,'created_by',r.created_by,'owner_id',r.owner_id,
 'title',r.title,'status',r.status,'scheduled_at',r.scheduled_at,'scheduled_local',r.scheduled_local,
 'timezone',r.timezone,'utc_offset_seconds',r.utc_offset_seconds,
 'resource',CASE WHEN r.task_id IS NOT NULL THEN jsonb_build_object('kind','task','id',r.task_id)
  WHEN r.plan_id IS NOT NULL THEN jsonb_build_object('kind','plan','id',r.plan_id)
  WHEN r.milestone_id IS NOT NULL THEN jsonb_build_object('kind','milestone','id',r.milestone_id) END,
 'is_due',r.status='pending' AND r.scheduled_at<=statement_timestamp(),'completed_at',r.completed_at,'dismissed_at',r.dismissed_at,
 'revision',r.revision,'created_at',r.created_at,'updated_at',r.updated_at)
 ||CASE WHEN details THEN jsonb_build_object('description',r.description) ELSE '{}'::jsonb END
 FROM app.reminders r WHERE r.id=target;
$$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.reminder_snapshot(target uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('exists',true,'revision',r.revision,'reminder_status',r.status,
 'reminder_scheduled_at',to_char(r.scheduled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'reminder_timezone',r.timezone) FROM app.reminders r WHERE r.id=target;
$$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.reminder_read(actor uuid,client uuid,target uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT app.authorization_allowed(actor,'reminders.view',client) OR NOT EXISTS(SELECT 1 FROM app.reminders WHERE id=target AND client_id=client) THEN RETURN NULL; END IF;
 RETURN app.reminder_document(target,true);
END; $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.reminder_list(actor uuid,client uuid,after_id uuid,page_limit integer,state text,due_filter text,owner_filter uuid,search text,descending boolean) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT app.authorization_allowed(actor,'reminders.view',client) OR NOT EXISTS(SELECT 1 FROM app.clients WHERE id=client) THEN RAISE no_data_found; END IF;
 IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 101 OR state IS NULL OR state NOT IN ('all','pending','completed','dismissed') OR
 due_filter IS NULL OR due_filter NOT IN ('all','due','upcoming') OR search IS NULL OR char_length(search)>100 OR search~'[[:cntrl:]]' OR descending IS NULL THEN RAISE invalid_parameter_value; END IF;
 RETURN QUERY SELECT app.reminder_document(r.id,false) FROM app.reminders r WHERE r.client_id=client
 AND (state='all' OR r.status=state) AND (owner_filter IS NULL OR r.owner_id=owner_filter)
 AND (due_filter='all' OR (r.status='pending' AND ((due_filter='due' AND r.scheduled_at<=statement_timestamp()) OR (due_filter='upcoming' AND r.scheduled_at>statement_timestamp()))))
 AND (search='' OR strpos(lower(r.title),lower(search))>0)
 AND (after_id IS NULL OR (NOT descending AND r.id>after_id) OR (descending AND r.id<after_id))
 ORDER BY CASE WHEN NOT descending THEN r.id END ASC,CASE WHEN descending THEN r.id END DESC LIMIT page_limit;
END; $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.reminder_owners(actor uuid,client uuid,after_id uuid,page_limit integer) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT app.authorization_allowed(actor,'reminders.view',client) OR
 NOT (app.authorization_allowed(actor,'reminders.create',client) OR app.authorization_allowed(actor,'reminders.update',client)) OR
 NOT EXISTS(SELECT 1 FROM app.clients WHERE id=client) THEN RAISE no_data_found; END IF;
 IF EXISTS(SELECT 1 FROM app.clients WHERE id=client AND archived_at IS NOT NULL) THEN RAISE SQLSTATE 'P0001' USING MESSAGE='archived client'; END IF;
 IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 101 THEN RAISE invalid_parameter_value; END IF;
 RETURN QUERY SELECT jsonb_build_object('id',u.id,'display_name',u.display_name) FROM app.users u
 WHERE u.status='active' AND app.authorization_allowed(u.id,'reminders.view',client)
 AND (after_id IS NULL OR u.id>after_id) ORDER BY u.id LIMIT page_limit;
END; $$;
-- +goose StatementEnd

-- Permission, lifecycle, owner and link checks occur after the shared lock wait.
-- +goose StatementBegin
CREATE FUNCTION app.reminder_write(actor uuid,client uuid,target uuid,expected bigint,operation text,profile jsonb)
RETURNS TABLE(code text,before_state jsonb,after_state jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous app.reminders%ROWTYPE; before_value jsonb:='null'::jsonb; stamp timestamptz;
 assigned uuid; scheduled timestamptz; local_time text; zone text; utc_offset integer;
 link_kind text; link_id uuid; linked_task uuid; linked_plan uuid; linked_milestone uuid; milestone_parent uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(871092650209);
 IF operation IS NULL OR operation NOT IN ('create','update','complete','dismiss') OR target IS NULL OR target='00000000-0000-0000-0000-000000000000' THEN RETURN QUERY SELECT 'invalid'::text,NULL::jsonb,NULL::jsonb;RETURN; END IF;
 IF NOT app.authorization_allowed(actor,'reminders.view',client) OR NOT app.authorization_allowed(actor,CASE WHEN operation='create' THEN 'reminders.create' ELSE 'reminders.update' END,client) OR
 NOT EXISTS(SELECT 1 FROM app.clients WHERE id=client) THEN RETURN QUERY SELECT 'missing'::text,NULL::jsonb,NULL::jsonb;RETURN; END IF;
 IF operation<>'create' THEN
  SELECT * INTO previous FROM app.reminders WHERE id=target AND client_id=client FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'missing'::text,NULL::jsonb,NULL::jsonb;RETURN; END IF;
  before_value:=app.reminder_snapshot(target);
 END IF;
 IF EXISTS(SELECT 1 FROM app.clients WHERE id=client AND archived_at IS NOT NULL) OR
 (operation='create' AND expected IS DISTINCT FROM 0::bigint) OR
 (operation<>'create' AND (expected IS NULL OR expected<1 OR expected=9223372036854775807 OR expected<>previous.revision OR previous.status<>'pending')) THEN RETURN QUERY SELECT 'conflict'::text,NULL::jsonb,NULL::jsonb;RETURN; END IF;
 stamp:=clock_timestamp();
 IF operation IN ('complete','dismiss') THEN
  UPDATE app.reminders SET status=CASE WHEN operation='complete' THEN 'completed' ELSE 'dismissed' END,
   completed_at=CASE WHEN operation='complete' THEN stamp END,dismissed_at=CASE WHEN operation='dismiss' THEN stamp END,
   revision=revision+1,updated_at=stamp WHERE id=target;
  RETURN QUERY SELECT 'ok'::text,before_value,app.reminder_snapshot(target);RETURN;
 END IF;
 IF profile IS NULL OR jsonb_typeof(profile)<>'object' OR profile-ARRAY['title','description','owner_id','scheduled_local','timezone','utc_offset_seconds','scheduled_at','resource']<>'{}'::jsonb OR
 jsonb_typeof(profile->'title') IS DISTINCT FROM 'string' OR jsonb_typeof(profile->'description') IS DISTINCT FROM 'string' OR
 jsonb_typeof(profile->'owner_id') IS DISTINCT FROM 'string' OR NOT coalesce(jsonb_typeof(profile->'resource') IN ('null','object'),false) THEN RETURN QUERY SELECT 'invalid'::text,NULL::jsonb,NULL::jsonb;RETURN; END IF;
 assigned:=(profile->>'owner_id')::uuid;
 IF (operation='create' OR assigned IS DISTINCT FROM previous.owner_id) AND
 (NOT EXISTS(SELECT 1 FROM app.users WHERE id=assigned AND status='active') OR NOT app.authorization_allowed(assigned,'reminders.view',client)) THEN RETURN QUERY SELECT 'invalid_owner'::text,NULL::jsonb,NULL::jsonb;RETURN; END IF;
 IF jsonb_typeof(profile->'scheduled_local') IS DISTINCT FROM 'string' OR jsonb_typeof(profile->'timezone') IS DISTINCT FROM 'string' OR
 jsonb_typeof(profile->'scheduled_at') IS DISTINCT FROM 'string' OR jsonb_typeof(profile->'utc_offset_seconds') IS DISTINCT FROM 'number' OR
 profile->>'utc_offset_seconds' !~ '^-?(0|[1-9][0-9]*)$' THEN RETURN QUERY SELECT 'invalid_schedule'::text,NULL::jsonb,NULL::jsonb;RETURN; END IF;
 local_time:=profile->>'scheduled_local';zone:=profile->>'timezone';utc_offset:=(profile->>'utc_offset_seconds')::integer;scheduled:=(profile->>'scheduled_at')::timestamptz;
 IF NOT app.reminder_schedule_valid(local_time,zone,utc_offset,scheduled) THEN RETURN QUERY SELECT 'invalid_schedule'::text,NULL::jsonb,NULL::jsonb;RETURN; END IF;
 IF jsonb_typeof(profile->'resource')='object' THEN
  IF (profile->'resource')-ARRAY['kind','id']<>'{}'::jsonb OR jsonb_typeof(profile->'resource'->'kind') IS DISTINCT FROM 'string' OR jsonb_typeof(profile->'resource'->'id') IS DISTINCT FROM 'string' THEN RETURN QUERY SELECT 'invalid'::text,NULL::jsonb,NULL::jsonb;RETURN; END IF;
  link_kind:=profile->'resource'->>'kind';link_id:=(profile->'resource'->>'id')::uuid;
  IF link_kind='task' THEN
   linked_task:=link_id;
   IF (operation='create' OR link_id IS DISTINCT FROM previous.task_id) AND (NOT app.authorization_allowed(actor,'tasks.view',client) OR NOT EXISTS(SELECT 1 FROM app.tasks WHERE id=link_id AND client_id=client AND archived_at IS NULL)) THEN RETURN QUERY SELECT 'invalid_resource'::text,NULL::jsonb,NULL::jsonb;RETURN; END IF;
  ELSIF link_kind='plan' THEN
   linked_plan:=link_id;
   IF (operation='create' OR link_id IS DISTINCT FROM previous.plan_id) AND (NOT app.authorization_allowed(actor,'planning.view',client) OR NOT EXISTS(SELECT 1 FROM app.plans WHERE id=link_id AND client_id=client AND archived_at IS NULL)) THEN RETURN QUERY SELECT 'invalid_resource'::text,NULL::jsonb,NULL::jsonb;RETURN; END IF;
  ELSIF link_kind='milestone' THEN
   linked_milestone:=link_id;
   IF operation='update' AND link_id IS NOT DISTINCT FROM previous.milestone_id THEN milestone_parent:=previous.milestone_plan_id;
   ELSE
    IF NOT app.authorization_allowed(actor,'planning.view',client) THEN RETURN QUERY SELECT 'invalid_resource'::text,NULL::jsonb,NULL::jsonb;RETURN; END IF;
    SELECT m.plan_id INTO milestone_parent FROM app.milestones m JOIN app.plans p ON p.id=m.plan_id AND p.client_id=m.client_id
     WHERE m.id=link_id AND m.client_id=client AND m.archived_at IS NULL AND p.archived_at IS NULL;
    IF NOT FOUND THEN RETURN QUERY SELECT 'invalid_resource'::text,NULL::jsonb,NULL::jsonb;RETURN; END IF;
   END IF;
  ELSE RETURN QUERY SELECT 'invalid'::text,NULL::jsonb,NULL::jsonb;RETURN;
  END IF;
 END IF;
 IF operation='create' THEN
  INSERT INTO app.reminders(id,client_id,created_by,owner_id,title,description,status,scheduled_at,scheduled_local,timezone,utc_offset_seconds,task_id,plan_id,milestone_id,milestone_plan_id,created_at,updated_at)
   VALUES(target,client,actor,assigned,profile->>'title',profile->>'description','pending',scheduled,local_time,zone,utc_offset,linked_task,linked_plan,linked_milestone,milestone_parent,stamp,stamp);
 ELSE
  UPDATE app.reminders SET owner_id=assigned,title=profile->>'title',description=profile->>'description',scheduled_at=scheduled,scheduled_local=local_time,
   timezone=zone,utc_offset_seconds=utc_offset,task_id=linked_task,plan_id=linked_plan,milestone_id=linked_milestone,milestone_plan_id=milestone_parent,revision=revision+1,updated_at=stamp WHERE id=target;
 END IF;
 RETURN QUERY SELECT 'ok'::text,before_value,app.reminder_snapshot(target);
EXCEPTION WHEN check_violation OR not_null_violation OR invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format OR foreign_key_violation OR numeric_value_out_of_range THEN RETURN QUERY SELECT 'invalid'::text,NULL::jsonb,NULL::jsonb;
 WHEN unique_violation THEN RETURN QUERY SELECT 'conflict'::text,NULL::jsonb,NULL::jsonb;
END; $$;
-- +goose StatementEnd

-- Extend only typed scheduling fields, with pairing, UTC and resource bounds.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.audit_snapshot_allowed(value jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE STRICT SET search_path=pg_catalog AS $$
DECLARE scheduled timestamptz;
BEGIN
 IF value='null'::jsonb THEN RETURN true; END IF;
 IF jsonb_typeof(value)<>'object' OR value-ARRAY['exists','revision','status','task_status','planning_status','reminder_status','reminder_scheduled_at','reminder_timezone']<>'{}'::jsonb THEN RETURN false; END IF;
 IF value ? 'exists' AND jsonb_typeof(value->'exists')<>'boolean' THEN RETURN false; END IF;
 IF value ? 'status' AND (jsonb_typeof(value->'status')<>'string' OR value->>'status' NOT IN ('active','disabled')) THEN RETURN false; END IF;
 IF value ? 'task_status' AND (jsonb_typeof(value->'task_status')<>'string' OR value->>'task_status' NOT IN ('backlog','todo','in_progress','blocked','review','done','cancelled')) THEN RETURN false; END IF;
 IF value ? 'planning_status' AND (jsonb_typeof(value->'planning_status')<>'string' OR value->>'planning_status' NOT IN ('draft','active','planned','in_progress','completed','cancelled')) THEN RETURN false; END IF;
 IF value ? 'reminder_status' AND (jsonb_typeof(value->'reminder_status')<>'string' OR value->>'reminder_status' NOT IN ('pending','completed','dismissed')) THEN RETURN false; END IF;
 IF (value ? 'reminder_scheduled_at')<>(value ? 'reminder_timezone') THEN RETURN false; END IF;
 IF value ? 'reminder_scheduled_at' THEN
  IF jsonb_typeof(value->'reminder_scheduled_at')<>'string' OR value->>'reminder_scheduled_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$' OR
  jsonb_typeof(value->'reminder_timezone')<>'string' OR char_length(value->>'reminder_timezone')>100 OR value->>'reminder_timezone' !~ '^(UTC|[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)+)$' OR
  NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=value->>'reminder_timezone') THEN RETURN false; END IF;
  scheduled:=(value->>'reminder_scheduled_at')::timestamptz;
  IF left(value->>'reminder_scheduled_at',19)<>to_char(scheduled AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS') THEN RETURN false; END IF;
  IF NOT isfinite(scheduled) OR scheduled<TIMESTAMPTZ '0001-01-01 00:00:00+00' OR scheduled>=TIMESTAMPTZ '10000-01-01 00:00:00+00' THEN RETURN false; END IF;
 END IF;
 IF value ? 'revision' THEN
  IF jsonb_typeof(value->'revision')<>'number' OR value->>'revision' !~ '^(0|[1-9][0-9]*)$' THEN RETURN false; END IF;
  IF (value->>'revision')::numeric>9223372036854775807 THEN RETURN false; END IF;
 END IF;
 RETURN true;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END; $$;
-- +goose StatementEnd
ALTER TABLE app.audit_events ADD CONSTRAINT audit_reminder_snapshot_kind CHECK (
 NOT (before_state ?| ARRAY['reminder_status','reminder_scheduled_at','reminder_timezone'] OR after_state ?| ARRAY['reminder_status','reminder_scheduled_at','reminder_timezone']) OR resource_kind='reminder');
ALTER TABLE app.audit_events DROP CONSTRAINT audit_event_action;
ALTER TABLE app.audit_events ADD CONSTRAINT audit_event_action CHECK (
 (resource_kind<>'reminder' AND (event_name IN (resource_kind||'.created',resource_kind||'.updated',resource_kind||'.archived',resource_kind||'.deleted') OR
 (resource_kind='user' AND event_name='user.disabled') OR (resource_kind='role' AND event_name='role.permission_changed') OR
 (resource_kind='task' AND event_name IN ('task.completed','task.cancelled')))) OR
 (resource_kind='reminder' AND event_name IN ('reminder.created','reminder.updated','reminder.completed','reminder.dismissed')));
REVOKE ALL ON app.reminders FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.reminder_schedule_consistent(text,text,integer,timestamptz),app.reminder_schedule_valid(text,text,integer,timestamptz),app.reminder_document(uuid,boolean),app.reminder_snapshot(uuid),
 app.reminder_read(uuid,uuid,uuid),app.reminder_list(uuid,uuid,uuid,integer,text,text,uuid,text,boolean),
 app.reminder_owners(uuid,uuid,uuid,integer),app.reminder_write(uuid,uuid,uuid,bigint,text,jsonb) FROM PUBLIC;

-- +goose Down
LOCK TABLE app.reminders,app.role_permissions,app.permissions,app.audit_events IN ACCESS EXCLUSIVE MODE;
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM app.reminders) OR EXISTS(SELECT 1 FROM app.audit_events WHERE resource_kind='reminder') OR
 EXISTS(SELECT 1 FROM app.role_permissions WHERE permission_key IN ('reminders.view','reminders.create','reminders.update') AND
 (NOT seeded OR revoked_at IS NOT NULL OR role_id<>'00000000-0000-4000-8000-000000000001'::uuid)) THEN RAISE EXCEPTION 'Rollback refused: reminder or permission history is not empty'; END IF;
END; $$;
-- +goose StatementEnd
DROP FUNCTION app.reminder_read(uuid,uuid,uuid),app.reminder_list(uuid,uuid,uuid,integer,text,text,uuid,text,boolean),app.reminder_owners(uuid,uuid,uuid,integer),app.reminder_write(uuid,uuid,uuid,bigint,text,jsonb);
DROP FUNCTION app.reminder_document(uuid,boolean),app.reminder_snapshot(uuid);
DROP TABLE app.reminders;
DROP FUNCTION app.reminder_schedule_valid(text,text,integer,timestamptz);
DROP FUNCTION app.reminder_schedule_consistent(text,text,integer,timestamptz);
DELETE FROM app.role_permissions WHERE permission_key IN ('reminders.view','reminders.create','reminders.update');
DELETE FROM app.permissions WHERE permission_key IN ('reminders.view','reminders.create','reminders.update');
ALTER TABLE app.audit_events DROP CONSTRAINT audit_reminder_snapshot_kind;
ALTER TABLE app.audit_events DROP CONSTRAINT audit_event_action;
ALTER TABLE app.audit_events ADD CONSTRAINT audit_event_action CHECK (
 event_name IN (resource_kind||'.created',resource_kind||'.updated',resource_kind||'.archived',resource_kind||'.deleted') OR
 (resource_kind='user' AND event_name='user.disabled') OR (resource_kind='role' AND event_name='role.permission_changed') OR
 (resource_kind='task' AND event_name IN ('task.completed','task.cancelled')));
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.audit_snapshot_allowed(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
BEGIN
 IF value='null'::jsonb THEN RETURN true; END IF;
 IF jsonb_typeof(value)<>'object' OR value-ARRAY['exists','revision','status','task_status','planning_status']<>'{}'::jsonb THEN RETURN false; END IF;
 IF value ? 'exists' AND jsonb_typeof(value->'exists')<>'boolean' THEN RETURN false; END IF;
 IF value ? 'status' AND (jsonb_typeof(value->'status')<>'string' OR value->>'status' NOT IN ('active','disabled')) THEN RETURN false; END IF;
 IF value ? 'task_status' AND (jsonb_typeof(value->'task_status')<>'string' OR value->>'task_status' NOT IN ('backlog','todo','in_progress','blocked','review','done','cancelled')) THEN RETURN false; END IF;
 IF value ? 'planning_status' AND (jsonb_typeof(value->'planning_status')<>'string' OR value->>'planning_status' NOT IN ('draft','active','planned','in_progress','completed','cancelled')) THEN RETURN false; END IF;
 IF value ? 'revision' THEN
  IF jsonb_typeof(value->'revision')<>'number' OR value->>'revision' !~ '^(0|[1-9][0-9]*)$' THEN RETURN false; END IF;
  IF (value->>'revision')::numeric>9223372036854775807 THEN RETURN false; END IF;
 END IF;
 RETURN true;
END; $$;
-- +goose StatementEnd
