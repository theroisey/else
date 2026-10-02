-- +goose Up
INSERT INTO app.permissions(permission_key,scope_kind,description) VALUES
 ('tasks.create','client','Create client tasks'),
 ('tasks.update','client','Update client tasks and status'),
 ('tasks.delete','client','Archive client tasks while preserving history');
INSERT INTO app.role_permissions(id,role_id,permission_key,seeded)
 SELECT gen_random_uuid(),'00000000-0000-4000-8000-000000000001'::uuid,permission_key,true
 FROM app.permissions WHERE permission_key IN ('tasks.create','tasks.update','tasks.delete');

CREATE TABLE app.tasks (
 id uuid PRIMARY KEY CHECK (id<>'00000000-0000-0000-0000-000000000000'),
 client_id uuid NOT NULL REFERENCES app.clients(id),
 created_by uuid NOT NULL REFERENCES app.users(id),
 assignee_id uuid REFERENCES app.users(id),
 title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200 AND title=btrim(title) AND title!~'[[:cntrl:]]'),
 description text NOT NULL DEFAULT '' CHECK (char_length(description)<=8000 AND replace(description,E'\n','')!~'[[:cntrl:]]'),
 status text NOT NULL CHECK (status IN ('backlog','todo','in_progress','blocked','review','done','cancelled')),
 priority text NOT NULL CHECK (priority IN ('low','medium','high','urgent')),
 start_at timestamptz,
 due_at timestamptz,
 completed_at timestamptz,
 cancelled_at timestamptz,
 revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 archived_at timestamptz,
 CHECK (start_at IS NULL OR due_at IS NULL OR due_at>=start_at),
 CHECK (start_at IS NULL OR (isfinite(start_at) AND start_at>=TIMESTAMPTZ '0001-01-01 00:00:00+00' AND start_at<TIMESTAMPTZ '10000-01-01 00:00:00+00')),
 CHECK (due_at IS NULL OR (isfinite(due_at) AND due_at>=TIMESTAMPTZ '0001-01-01 00:00:00+00' AND due_at<TIMESTAMPTZ '10000-01-01 00:00:00+00')),
 CHECK ((status='done')=(completed_at IS NOT NULL)),
 CHECK ((status='cancelled')=(cancelled_at IS NOT NULL)),
 CHECK (updated_at>=created_at AND (archived_at IS NULL OR archived_at>=created_at)
  AND (completed_at IS NULL OR completed_at>=created_at) AND (cancelled_at IS NULL OR cancelled_at>=created_at))
);
CREATE INDEX tasks_active_client_id ON app.tasks(client_id,id) WHERE archived_at IS NULL;
CREATE INDEX tasks_archived_client_id ON app.tasks(client_id,id) WHERE archived_at IS NOT NULL;
CREATE INDEX tasks_client_status_id ON app.tasks(client_id,status,id);
CREATE INDEX tasks_client_assignee_id ON app.tasks(client_id,assignee_id,id);
CREATE TABLE app.task_tags (
 task_id uuid NOT NULL REFERENCES app.tasks(id),
 tag text NOT NULL CHECK (char_length(tag) BETWEEN 1 AND 40 AND tag=btrim(tag) AND tag=lower(tag) AND tag!~'[[:cntrl:]]'),
 PRIMARY KEY(task_id,tag)
);
CREATE INDEX task_tags_lookup ON app.task_tags(tag,task_id);

-- Private helpers are never granted to runtime.
-- +goose StatementBegin
CREATE FUNCTION app.task_allowed(actor uuid,permission text,client uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT app.authorization_allowed(actor,permission,client) OR
  (permission IN ('tasks.create','tasks.update','tasks.delete') AND app.authorization_allowed(actor,'tasks.manage',client));
$$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.task_transition(previous text,next text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE previous
 WHEN 'backlog' THEN next IN ('todo','cancelled')
 WHEN 'todo' THEN next IN ('backlog','in_progress','blocked','cancelled')
 WHEN 'in_progress' THEN next IN ('todo','blocked','review','done','cancelled')
 WHEN 'blocked' THEN next IN ('todo','in_progress','cancelled')
 WHEN 'review' THEN next IN ('in_progress','blocked','done','cancelled')
 WHEN 'done' THEN next='in_progress'
 WHEN 'cancelled' THEN next IN ('backlog','todo') ELSE false END;
$$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.task_document(target uuid,details boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',t.id,'client_id',t.client_id,'created_by',t.created_by,'assignee_id',t.assignee_id,
 'title',t.title,'status',t.status,'priority',t.priority,'start_at',t.start_at,'due_at',t.due_at,
 'completed_at',t.completed_at,'cancelled_at',t.cancelled_at,'revision',t.revision,
 'created_at',t.created_at,'updated_at',t.updated_at,'archived_at',t.archived_at,
 'tags',coalesce((SELECT jsonb_agg(g.tag ORDER BY g.tag) FROM app.task_tags g WHERE g.task_id=t.id),'[]'::jsonb))
 || CASE WHEN details THEN jsonb_build_object('description',t.description) ELSE '{}'::jsonb END
 FROM app.tasks t WHERE t.id=target;
$$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.task_read(actor uuid,client uuid,target uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT app.authorization_allowed(actor,'tasks.view',client) OR NOT EXISTS(SELECT 1 FROM app.clients WHERE id=client) THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.tasks WHERE id=target AND client_id=client) THEN RETURN NULL; END IF;
 RETURN app.task_document(target,true);
END; $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.task_list(actor uuid,client uuid,after_id uuid,page_limit integer,state text,importance text,
 assigned uuid,unassigned boolean,search text,tag_filter text,archive_filter text,descending boolean) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT app.authorization_allowed(actor,'tasks.view',client) OR NOT EXISTS(SELECT 1 FROM app.clients WHERE id=client) THEN RAISE no_data_found; END IF;
 IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 101 OR state IS NULL OR state NOT IN ('all','backlog','todo','in_progress','blocked','review','done','cancelled') OR
 importance IS NULL OR importance NOT IN ('all','low','medium','high','urgent') OR unassigned IS NULL OR (unassigned AND assigned IS NOT NULL) OR
 search IS NULL OR char_length(search)>100 OR tag_filter IS NULL OR char_length(tag_filter)>40 OR
 archive_filter IS NULL OR archive_filter NOT IN ('false','true','all') OR descending IS NULL THEN RAISE invalid_parameter_value; END IF;
 RETURN QUERY SELECT app.task_document(t.id,false) FROM app.tasks t WHERE t.client_id=client
 AND (state='all' OR t.status=state) AND (importance='all' OR t.priority=importance)
 AND (assigned IS NULL OR t.assignee_id=assigned) AND (NOT unassigned OR t.assignee_id IS NULL)
 AND (search='' OR strpos(lower(t.title),lower(search))>0)
 AND (tag_filter='' OR EXISTS(SELECT 1 FROM app.task_tags g WHERE g.task_id=t.id AND g.tag=tag_filter))
 AND (archive_filter='all' OR (archive_filter='false' AND t.archived_at IS NULL) OR (archive_filter='true' AND t.archived_at IS NOT NULL))
 AND (after_id IS NULL OR (NOT descending AND t.id>after_id) OR (descending AND t.id<after_id))
 ORDER BY CASE WHEN NOT descending THEN t.id END ASC,CASE WHEN descending THEN t.id END DESC LIMIT page_limit;
END; $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.task_assignees(actor uuid,client uuid,after_id uuid,page_limit integer) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT app.authorization_allowed(actor,'tasks.view',client) OR
 NOT (app.task_allowed(actor,'tasks.create',client) OR app.task_allowed(actor,'tasks.update',client)) OR
 NOT EXISTS(SELECT 1 FROM app.clients WHERE id=client) THEN RAISE no_data_found; END IF;
 IF EXISTS(SELECT 1 FROM app.clients WHERE id=client AND archived_at IS NOT NULL) THEN RAISE SQLSTATE 'P0001' USING MESSAGE='archived client'; END IF;
 IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 101 THEN RAISE invalid_parameter_value; END IF;
 RETURN QUERY SELECT jsonb_build_object('id',u.id,'display_name',u.display_name) FROM app.users u
 WHERE u.status='active' AND app.authorization_allowed(u.id,'tasks.view',client)
 AND (after_id IS NULL OR u.id>after_id) ORDER BY u.id LIMIT page_limit;
END; $$;
-- +goose StatementEnd

-- Permission and assignee reads must happen AFTER waiting on the shared lock.
-- +goose StatementBegin
CREATE FUNCTION app.task_write(actor uuid,client uuid,target uuid,expected bigint,operation text,profile jsonb,next_state text)
RETURNS TABLE(code text,before_status text,after_status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE record app.tasks%ROWTYPE; permission text; assigned uuid; starts timestamptz; due timestamptz; stamp timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock(871092650209);
 IF operation IS NULL OR operation NOT IN ('create','update','status','archive') OR target IS NULL OR target='00000000-0000-0000-0000-000000000000' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END IF;
 permission:=CASE operation WHEN 'create' THEN 'tasks.create' WHEN 'archive' THEN 'tasks.delete' ELSE 'tasks.update' END;
 IF NOT app.task_allowed(actor,permission,client) OR NOT EXISTS(SELECT 1 FROM app.clients WHERE id=client) THEN
  RETURN QUERY SELECT 'missing'::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF operation<>'create' THEN
  SELECT * INTO record FROM app.tasks WHERE id=target AND client_id=client FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'missing'::text,NULL::text,NULL::text; RETURN; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM app.clients WHERE id=client AND archived_at IS NOT NULL) OR
 (operation='create' AND expected IS DISTINCT FROM 0::bigint) OR
 (operation<>'create' AND (expected IS NULL OR expected<1 OR expected<>record.revision OR record.archived_at IS NOT NULL)) THEN
  RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text; RETURN;
 END IF;
 stamp:=clock_timestamp();
 IF operation='archive' THEN
  UPDATE app.tasks SET archived_at=stamp,updated_at=stamp,revision=revision+1 WHERE id=target;
  RETURN QUERY SELECT 'ok'::text,record.status,record.status; RETURN;
 ELSIF operation='status' THEN
  IF NOT coalesce(app.task_transition(record.status,next_state),false) THEN RETURN QUERY SELECT 'invalid_transition'::text,NULL::text,NULL::text; RETURN; END IF;
  UPDATE app.tasks SET status=next_state,completed_at=CASE WHEN next_state='done' THEN stamp END,
   cancelled_at=CASE WHEN next_state='cancelled' THEN stamp END,updated_at=stamp,revision=revision+1 WHERE id=target;
  RETURN QUERY SELECT 'ok'::text,record.status,next_state; RETURN;
 END IF;
 IF operation='update' AND record.status IN ('done','cancelled') THEN RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text; RETURN; END IF;
 IF operation='create' AND (next_state IS NULL OR next_state NOT IN ('backlog','todo')) THEN RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN; END IF;
 IF profile IS NULL OR jsonb_typeof(profile)<>'object' OR profile-ARRAY['title','description','priority','assignee_id','start_at','due_at','tags']<>'{}'::jsonb OR
 jsonb_typeof(profile->'title') IS DISTINCT FROM 'string' OR jsonb_typeof(profile->'description') IS DISTINCT FROM 'string' OR
 jsonb_typeof(profile->'priority') IS DISTINCT FROM 'string' OR jsonb_typeof(profile->'tags') IS DISTINCT FROM 'array' OR
 NOT coalesce(jsonb_typeof(profile->'assignee_id') IN ('null','string'),false) OR
 NOT coalesce(jsonb_typeof(profile->'start_at') IN ('null','string'),false) OR NOT coalesce(jsonb_typeof(profile->'due_at') IN ('null','string'),false) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF jsonb_array_length(profile->'tags')>20 OR EXISTS(SELECT 1 FROM jsonb_array_elements(profile->'tags') p WHERE jsonb_typeof(p)<>'string') THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END IF;
 assigned:=(profile->>'assignee_id')::uuid; starts:=(profile->>'start_at')::timestamptz; due:=(profile->>'due_at')::timestamptz;
 IF assigned IS NOT NULL AND (operation='create' OR assigned IS DISTINCT FROM record.assignee_id) AND NOT app.authorization_allowed(assigned,'tasks.view',client) THEN
  RETURN QUERY SELECT 'invalid_assignee'::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF operation='create' THEN
  INSERT INTO app.tasks(id,client_id,created_by,assignee_id,title,description,status,priority,start_at,due_at)
  VALUES(target,client,actor,assigned,profile->>'title',profile->>'description',next_state,profile->>'priority',starts,due);
 ELSE
  UPDATE app.tasks SET title=profile->>'title',description=profile->>'description',priority=profile->>'priority',assignee_id=assigned,
  start_at=starts,due_at=due,revision=revision+1,updated_at=stamp WHERE id=target;
  DELETE FROM app.task_tags WHERE task_id=target;
 END IF;
 INSERT INTO app.task_tags(task_id,tag) SELECT target,p#>>'{}' FROM jsonb_array_elements(profile->'tags') p;
 RETURN QUERY SELECT 'ok'::text,record.status,CASE WHEN operation='create' THEN next_state ELSE record.status END;
EXCEPTION WHEN check_violation OR not_null_violation OR invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format OR foreign_key_violation THEN
 RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text;
 WHEN unique_violation THEN RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text;
END; $$;
-- +goose StatementEnd

-- Add only reviewed task state markers to the existing audit allowlist.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.audit_snapshot_allowed(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
BEGIN
 IF value='null'::jsonb THEN RETURN true; END IF;
 IF jsonb_typeof(value)<>'object' OR value-ARRAY['exists','revision','status','task_status']<>'{}'::jsonb THEN RETURN false; END IF;
 IF value ? 'exists' AND jsonb_typeof(value->'exists')<>'boolean' THEN RETURN false; END IF;
 IF value ? 'status' AND (jsonb_typeof(value->'status')<>'string' OR value->>'status' NOT IN ('active','disabled')) THEN RETURN false; END IF;
 IF value ? 'task_status' AND (jsonb_typeof(value->'task_status')<>'string' OR value->>'task_status' NOT IN ('backlog','todo','in_progress','blocked','review','done','cancelled')) THEN RETURN false; END IF;
 IF value ? 'revision' THEN
  IF jsonb_typeof(value->'revision')<>'number' OR value->>'revision' !~ '^(0|[1-9][0-9]*)$' THEN RETURN false; END IF;
  IF (value->>'revision')::numeric>9223372036854775807 THEN RETURN false; END IF;
 END IF;
 RETURN true;
END; $$;
-- +goose StatementEnd
ALTER TABLE app.audit_events DROP CONSTRAINT audit_event_action;
ALTER TABLE app.audit_events ADD CONSTRAINT audit_event_action CHECK (
 event_name IN (resource_kind||'.created',resource_kind||'.updated',resource_kind||'.archived',resource_kind||'.deleted') OR
 (resource_kind='user' AND event_name='user.disabled') OR (resource_kind='role' AND event_name='role.permission_changed') OR
 (resource_kind='task' AND event_name IN ('task.completed','task.cancelled')));
ALTER TABLE app.audit_events ADD CONSTRAINT audit_task_snapshot_kind CHECK (
 resource_kind='task' OR NOT (before_state ? 'task_status' OR after_state ? 'task_status'));
REVOKE ALL ON app.tasks,app.task_tags FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.task_allowed(uuid,text,uuid),app.task_transition(text,text),app.task_document(uuid,boolean),
 app.task_read(uuid,uuid,uuid),app.task_list(uuid,uuid,uuid,integer,text,text,uuid,boolean,text,text,text,boolean),
 app.task_assignees(uuid,uuid,uuid,integer),app.task_write(uuid,uuid,uuid,bigint,text,jsonb,text) FROM PUBLIC;

-- +goose Down
LOCK TABLE app.tasks,app.task_tags,app.role_permissions,app.permissions,app.audit_events IN ACCESS EXCLUSIVE MODE;
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM app.tasks) OR EXISTS(SELECT 1 FROM app.audit_events WHERE resource_kind='task') OR
 EXISTS(SELECT 1 FROM app.role_permissions WHERE permission_key IN ('tasks.create','tasks.update','tasks.delete') AND
  (NOT seeded OR revoked_at IS NOT NULL OR role_id<>'00000000-0000-4000-8000-000000000001'::uuid)) THEN
  RAISE EXCEPTION 'Rollback refused: task or granular permission history is not empty';
 END IF;
END; $$;
-- +goose StatementEnd
DROP FUNCTION app.task_read(uuid,uuid,uuid),app.task_list(uuid,uuid,uuid,integer,text,text,uuid,boolean,text,text,text,boolean),
 app.task_assignees(uuid,uuid,uuid,integer),app.task_write(uuid,uuid,uuid,bigint,text,jsonb,text);
DROP FUNCTION app.task_allowed(uuid,text,uuid),app.task_transition(text,text),app.task_document(uuid,boolean);
DROP TABLE app.task_tags,app.tasks;
DELETE FROM app.role_permissions WHERE permission_key IN ('tasks.create','tasks.update','tasks.delete');
DELETE FROM app.permissions WHERE permission_key IN ('tasks.create','tasks.update','tasks.delete');
ALTER TABLE app.audit_events DROP CONSTRAINT audit_task_snapshot_kind;
ALTER TABLE app.audit_events DROP CONSTRAINT audit_event_action;
ALTER TABLE app.audit_events ADD CONSTRAINT audit_event_action CHECK (
 event_name IN (resource_kind||'.created',resource_kind||'.updated',resource_kind||'.archived',resource_kind||'.deleted') OR
 (resource_kind='user' AND event_name='user.disabled') OR (resource_kind='role' AND event_name='role.permission_changed'));
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.audit_snapshot_allowed(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
BEGIN
 IF value='null'::jsonb THEN RETURN true; END IF;
 IF jsonb_typeof(value)<>'object' OR value-ARRAY['exists','revision','status']<>'{}'::jsonb THEN RETURN false; END IF;
 IF value ? 'exists' AND jsonb_typeof(value->'exists')<>'boolean' THEN RETURN false; END IF;
 IF value ? 'status' AND (jsonb_typeof(value->'status')<>'string' OR value->>'status' NOT IN ('active','disabled')) THEN RETURN false; END IF;
 IF value ? 'revision' THEN
  IF jsonb_typeof(value->'revision')<>'number' OR value->>'revision' !~ '^(0|[1-9][0-9]*)$' THEN RETURN false; END IF;
  IF (value->>'revision')::numeric>9223372036854775807 THEN RETURN false; END IF;
 END IF;
 RETURN true;
END; $$;
-- +goose StatementEnd
