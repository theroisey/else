-- +goose Up
INSERT INTO app.permissions(permission_key,scope_kind,description) VALUES
 ('planning.view','client','View client plans and milestones'),
 ('planning.create','client','Create client plans and milestones'),
 ('planning.update','client','Update client plans, milestones and task links'),
 ('planning.archive','client','Archive planning records while preserving history');
INSERT INTO app.role_permissions(id,role_id,permission_key,seeded)
 SELECT gen_random_uuid(),'00000000-0000-4000-8000-000000000001'::uuid,permission_key,true
 FROM app.permissions WHERE permission_key IN ('planning.view','planning.create','planning.update','planning.archive');

CREATE TABLE app.plans (
 id uuid PRIMARY KEY CHECK(id<>'00000000-0000-0000-0000-000000000000'),
 client_id uuid NOT NULL REFERENCES app.clients(id),
 created_by uuid NOT NULL REFERENCES app.users(id),
 title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 200 AND title=btrim(title) AND title!~'[[:cntrl:]]'),
 description text NOT NULL DEFAULT '' CHECK(char_length(description)<=8000 AND replace(description,E'\n','')!~'[[:cntrl:]]'),
 status text NOT NULL CHECK(status IN ('draft','active','completed','cancelled')),
 start_at timestamptz,
 due_at timestamptz,
 completed_at timestamptz,
 cancelled_at timestamptz,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 archived_at timestamptz,
 UNIQUE(id,client_id),
 CHECK(start_at IS NULL OR (isfinite(start_at) AND start_at>=TIMESTAMPTZ '0001-01-01 00:00:00+00' AND start_at<TIMESTAMPTZ '10000-01-01 00:00:00+00')),
 CHECK(due_at IS NULL OR (isfinite(due_at) AND due_at>=TIMESTAMPTZ '0001-01-01 00:00:00+00' AND due_at<TIMESTAMPTZ '10000-01-01 00:00:00+00')),
 CHECK(start_at IS NULL OR due_at IS NULL OR due_at>=start_at),
 CHECK((status='completed')=(completed_at IS NOT NULL)),
 CHECK((status='cancelled')=(cancelled_at IS NOT NULL)),
 CHECK(updated_at>=created_at AND (archived_at IS NULL OR archived_at>=created_at)
  AND (completed_at IS NULL OR completed_at>=created_at) AND (cancelled_at IS NULL OR cancelled_at>=created_at))
);
CREATE INDEX plans_client_id ON app.plans(client_id,id);
CREATE INDEX plans_client_status_id ON app.plans(client_id,status,id);
CREATE TABLE app.milestones (
 id uuid PRIMARY KEY CHECK(id<>'00000000-0000-0000-0000-000000000000'),
 plan_id uuid NOT NULL,
 client_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES app.users(id),
 title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 200 AND title=btrim(title) AND title!~'[[:cntrl:]]'),
 description text NOT NULL DEFAULT '' CHECK(char_length(description)<=8000 AND replace(description,E'\n','')!~'[[:cntrl:]]'),
 status text NOT NULL CHECK(status IN ('planned','in_progress','completed','cancelled')),
 due_at timestamptz,
 completed_at timestamptz,
 cancelled_at timestamptz,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 archived_at timestamptz,
 UNIQUE(id,plan_id,client_id),
 FOREIGN KEY(plan_id,client_id) REFERENCES app.plans(id,client_id),
 CHECK(due_at IS NULL OR (isfinite(due_at) AND due_at>=TIMESTAMPTZ '0001-01-01 00:00:00+00' AND due_at<TIMESTAMPTZ '10000-01-01 00:00:00+00')),
 CHECK((status='completed')=(completed_at IS NOT NULL)),
 CHECK((status='cancelled')=(cancelled_at IS NOT NULL)),
 CHECK(updated_at>=created_at AND (archived_at IS NULL OR archived_at>=created_at)
  AND (completed_at IS NULL OR completed_at>=created_at) AND (cancelled_at IS NULL OR cancelled_at>=created_at))
);
CREATE INDEX milestones_plan_id ON app.milestones(plan_id,client_id,id);
CREATE INDEX milestones_plan_due ON app.milestones(plan_id,due_at) WHERE archived_at IS NULL;
ALTER TABLE app.tasks ADD CONSTRAINT tasks_id_client_unique UNIQUE(id,client_id);
CREATE TABLE app.milestone_task_links (
 id uuid PRIMARY KEY,
 milestone_id uuid NOT NULL,
 plan_id uuid NOT NULL,
 client_id uuid NOT NULL,
 task_id uuid NOT NULL,
 linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 unlinked_at timestamptz CHECK(unlinked_at IS NULL OR unlinked_at>=linked_at),
 FOREIGN KEY(milestone_id,plan_id,client_id) REFERENCES app.milestones(id,plan_id,client_id),
 FOREIGN KEY(task_id,client_id) REFERENCES app.tasks(id,client_id)
);
CREATE UNIQUE INDEX milestone_links_active ON app.milestone_task_links(milestone_id,task_id) WHERE unlinked_at IS NULL;
CREATE INDEX milestone_links_page ON app.milestone_task_links(milestone_id,id);
CREATE INDEX milestone_links_task ON app.milestone_task_links(task_id,client_id);

-- Private helpers are not part of the runtime boundary.
-- +goose StatementBegin
CREATE FUNCTION app.planning_transition(previous text,next text,milestone boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN milestone THEN CASE previous
 WHEN 'planned' THEN next IN ('in_progress','completed','cancelled')
 WHEN 'in_progress' THEN next IN ('planned','completed','cancelled')
 WHEN 'completed' THEN next='in_progress'
 WHEN 'cancelled' THEN next IN ('planned','in_progress') ELSE false END
 ELSE CASE previous WHEN 'draft' THEN next IN ('active','cancelled')
 WHEN 'active' THEN next IN ('draft','completed','cancelled')
 WHEN 'completed' THEN next='active' WHEN 'cancelled' THEN next IN ('draft','active') ELSE false END END;
$$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.planning_document(parent uuid,target uuid,details boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb;
BEGIN
 IF parent IS NULL THEN SELECT to_jsonb(p) INTO result FROM app.plans p WHERE p.id=target;
 ELSE SELECT to_jsonb(m)||jsonb_build_object('start_at',NULL) INTO result FROM app.milestones m WHERE m.id=target AND m.plan_id=parent;
  IF details THEN result:=result||jsonb_build_object('task_ids',coalesce((SELECT jsonb_agg(l.task_id ORDER BY l.task_id)
   FROM app.milestone_task_links l WHERE l.milestone_id=target AND l.unlinked_at IS NULL),'[]'::jsonb)); END IF;
 END IF;
 RETURN CASE WHEN details THEN result ELSE result-'description' END;
END; $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.planning_read(actor uuid,client uuid,parent uuid,target uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT app.authorization_allowed(actor,'planning.view',client) OR NOT EXISTS(SELECT 1 FROM app.clients WHERE id=client) THEN RETURN NULL; END IF;
 IF parent IS NULL THEN IF NOT EXISTS(SELECT 1 FROM app.plans WHERE id=target AND client_id=client) THEN RETURN NULL; END IF;
 ELSE IF NOT EXISTS(SELECT 1 FROM app.milestones WHERE id=target AND client_id=client AND plan_id=parent) THEN RETURN NULL; END IF;
 END IF;
 RETURN app.planning_document(parent,target,true);
END; $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.planning_list(actor uuid,client uuid,parent uuid,after_id uuid,page_limit integer,state text,search text,archive_filter text,descending boolean) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT app.authorization_allowed(actor,'planning.view',client) OR NOT EXISTS(SELECT 1 FROM app.clients WHERE id=client) OR
 (parent IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.plans WHERE id=parent AND client_id=client)) THEN RAISE no_data_found; END IF;
 IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 101 OR search IS NULL OR char_length(search)>100 OR search~'[[:cntrl:]]' OR
 archive_filter IS NULL OR archive_filter NOT IN ('false','true','all') OR descending IS NULL OR state IS NULL OR
 (parent IS NULL AND state NOT IN ('all','draft','active','completed','cancelled')) OR
 (parent IS NOT NULL AND state NOT IN ('all','planned','in_progress','completed','cancelled')) THEN RAISE invalid_parameter_value; END IF;
 IF parent IS NULL THEN
  RETURN QUERY SELECT app.planning_document(NULL,p.id,false) FROM app.plans p WHERE p.client_id=client
  AND (state='all' OR p.status=state) AND (search='' OR strpos(lower(p.title),lower(search))>0)
  AND (archive_filter='all' OR (archive_filter='false' AND p.archived_at IS NULL) OR (archive_filter='true' AND p.archived_at IS NOT NULL))
  AND (after_id IS NULL OR (NOT descending AND p.id>after_id) OR (descending AND p.id<after_id))
  ORDER BY CASE WHEN NOT descending THEN p.id END ASC,CASE WHEN descending THEN p.id END DESC LIMIT page_limit;
 ELSE
  RETURN QUERY SELECT app.planning_document(parent,m.id,false) FROM app.milestones m WHERE m.plan_id=parent AND m.client_id=client
  AND (state='all' OR m.status=state) AND (search='' OR strpos(lower(m.title),lower(search))>0)
  AND (archive_filter='all' OR (archive_filter='false' AND m.archived_at IS NULL) OR (archive_filter='true' AND m.archived_at IS NOT NULL))
  AND (after_id IS NULL OR (NOT descending AND m.id>after_id) OR (descending AND m.id<after_id))
  ORDER BY CASE WHEN NOT descending THEN m.id END ASC,CASE WHEN descending THEN m.id END DESC LIMIT page_limit;
 END IF;
END; $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.planning_links(actor uuid,client uuid,parent uuid,target uuid,after_id uuid,page_limit integer,archive_filter text,descending boolean) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF parent IS NULL OR app.planning_read(actor,client,parent,target) IS NULL THEN RAISE no_data_found; END IF;
 IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 101 OR archive_filter IS NULL OR archive_filter NOT IN ('false','true','all') OR descending IS NULL THEN RAISE invalid_parameter_value; END IF;
 RETURN QUERY SELECT jsonb_build_object('id',l.id,'task_id',l.task_id,'linked_at',l.linked_at,'unlinked_at',l.unlinked_at)
 FROM app.milestone_task_links l WHERE l.milestone_id=target AND l.plan_id=parent AND l.client_id=client
 AND (archive_filter='all' OR (archive_filter='false' AND l.unlinked_at IS NULL) OR (archive_filter='true' AND l.unlinked_at IS NOT NULL))
 AND (after_id IS NULL OR (NOT descending AND l.id>after_id) OR (descending AND l.id<after_id))
 ORDER BY CASE WHEN NOT descending THEN l.id END ASC,CASE WHEN descending THEN l.id END DESC LIMIT page_limit;
END; $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.planning_task_candidates(actor uuid,client uuid,parent uuid,after_id uuid,page_limit integer,search text,descending boolean) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT app.authorization_allowed(actor,'planning.view',client) OR NOT app.authorization_allowed(actor,'tasks.view',client) OR
 NOT (app.authorization_allowed(actor,'planning.create',client) OR app.authorization_allowed(actor,'planning.update',client)) OR
 NOT EXISTS(SELECT 1 FROM app.plans WHERE id=parent AND client_id=client) THEN RAISE no_data_found; END IF;
 IF EXISTS(SELECT 1 FROM app.clients WHERE id=client AND archived_at IS NOT NULL) OR
 EXISTS(SELECT 1 FROM app.plans WHERE id=parent AND (archived_at IS NOT NULL OR status IN ('completed','cancelled'))) THEN RAISE SQLSTATE 'P0001'; END IF;
 IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 101 OR search IS NULL OR char_length(search)>100 OR search~'[[:cntrl:]]' OR descending IS NULL THEN RAISE invalid_parameter_value; END IF;
 RETURN QUERY SELECT jsonb_build_object('id',t.id,'title',t.title,'status',t.status) FROM app.tasks t WHERE t.client_id=client AND t.archived_at IS NULL
 AND (search='' OR strpos(lower(t.title),lower(search))>0) AND (after_id IS NULL OR (NOT descending AND t.id>after_id) OR (descending AND t.id<after_id))
 ORDER BY CASE WHEN NOT descending THEN t.id END ASC,CASE WHEN descending THEN t.id END DESC LIMIT page_limit;
END; $$;
-- +goose StatementEnd

-- All authorization, parent and task checks run after the shared writer lock.
-- +goose StatementBegin
CREATE FUNCTION app.planning_write(actor uuid,client uuid,parent uuid,target uuid,expected bigint,operation text,profile jsonb,next_state text,task_ids jsonb)
RETURNS TABLE(result text,previous_status text,current_status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE permission text;plan app.plans%ROWTYPE;milestone app.milestones%ROWTYPE;old_state text;old_revision bigint;old_archive timestamptz;
 stamp timestamptz;starts timestamptz;due timestamptz;selected uuid[];initial text;
BEGIN
 PERFORM pg_advisory_xact_lock(871092650209);
 IF operation IS NULL OR operation NOT IN ('create','update','status','archive','links') OR target IS NULL OR
 target='00000000-0000-0000-0000-000000000000' OR (operation='links' AND parent IS NULL) THEN RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text;RETURN; END IF;
 permission:=CASE operation WHEN 'create' THEN 'planning.create' WHEN 'archive' THEN 'planning.archive' ELSE 'planning.update' END;
 IF NOT app.authorization_allowed(actor,'planning.view',client) OR NOT app.authorization_allowed(actor,permission,client) OR
 NOT EXISTS(SELECT 1 FROM app.clients WHERE id=client) THEN RETURN QUERY SELECT 'missing'::text,NULL::text,NULL::text;RETURN; END IF;
 IF parent IS NOT NULL THEN
  SELECT * INTO plan FROM app.plans WHERE id=parent AND client_id=client FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'missing'::text,NULL::text,NULL::text;RETURN; END IF;
  IF operation<>'create' THEN
   SELECT * INTO milestone FROM app.milestones WHERE id=target AND plan_id=parent AND client_id=client FOR UPDATE;
   IF NOT FOUND THEN RETURN QUERY SELECT 'missing'::text,NULL::text,NULL::text;RETURN; END IF;
   old_state:=milestone.status;old_revision:=milestone.revision;old_archive:=milestone.archived_at;
  END IF;
 ELSIF operation<>'create' THEN
  SELECT * INTO plan FROM app.plans WHERE id=target AND client_id=client FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'missing'::text,NULL::text,NULL::text;RETURN; END IF;
  old_state:=plan.status;old_revision:=plan.revision;old_archive:=plan.archived_at;
 END IF;
 IF EXISTS(SELECT 1 FROM app.clients WHERE id=client AND archived_at IS NOT NULL) OR
 (parent IS NOT NULL AND (plan.archived_at IS NOT NULL OR plan.status IN ('completed','cancelled'))) OR
 (operation='create' AND expected IS DISTINCT FROM 0::bigint) OR
 (operation<>'create' AND (expected IS NULL OR expected<1 OR expected=9223372036854775807 OR expected<>old_revision OR old_archive IS NOT NULL)) THEN
 RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text;RETURN; END IF;
 stamp:=clock_timestamp();
 IF operation='archive' THEN
  IF parent IS NULL THEN UPDATE app.plans SET archived_at=stamp,updated_at=stamp,revision=revision+1 WHERE id=target;
  ELSE UPDATE app.milestones SET archived_at=stamp,updated_at=stamp,revision=revision+1 WHERE id=target; END IF;
  RETURN QUERY SELECT 'ok'::text,old_state,old_state;RETURN;
 ELSIF operation='status' THEN
  IF NOT coalesce(app.planning_transition(old_state,next_state,parent IS NOT NULL),false) THEN RETURN QUERY SELECT 'invalid_transition'::text,NULL::text,NULL::text;RETURN; END IF;
  IF parent IS NULL THEN UPDATE app.plans SET status=next_state,completed_at=CASE WHEN next_state='completed' THEN stamp END,
   cancelled_at=CASE WHEN next_state='cancelled' THEN stamp END,updated_at=stamp,revision=revision+1 WHERE id=target;
  ELSE UPDATE app.milestones SET status=next_state,completed_at=CASE WHEN next_state='completed' THEN stamp END,
   cancelled_at=CASE WHEN next_state='cancelled' THEN stamp END,updated_at=stamp,revision=revision+1 WHERE id=target; END IF;
  RETURN QUERY SELECT 'ok'::text,old_state,next_state;RETURN;
 END IF;
 IF operation<>'create' AND old_state IN ('completed','cancelled') THEN RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text;RETURN; END IF;
 IF operation='links' THEN
  IF task_ids IS NULL OR jsonb_typeof(task_ids)<>'array' THEN RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text;RETURN; END IF;
  IF jsonb_array_length(task_ids)>50 OR EXISTS(SELECT 1 FROM jsonb_array_elements(task_ids) v WHERE jsonb_typeof(v)<>'string') THEN RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text;RETURN; END IF;
  SELECT coalesce(array_agg(v::uuid),ARRAY[]::uuid[]) INTO selected FROM jsonb_array_elements_text(task_ids) v;
  IF cardinality(selected)<>(SELECT count(DISTINCT v) FROM unnest(selected) v) OR '00000000-0000-0000-0000-000000000000'::uuid=ANY(selected) THEN RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text;RETURN; END IF;
  IF EXISTS(SELECT 1 FROM unnest(selected) v WHERE NOT EXISTS(SELECT 1 FROM app.milestone_task_links l WHERE l.milestone_id=target AND l.task_id=v AND l.unlinked_at IS NULL)
   AND (NOT app.authorization_allowed(actor,'tasks.view',client) OR NOT EXISTS(SELECT 1 FROM app.tasks t WHERE t.id=v AND t.client_id=client AND t.archived_at IS NULL))) THEN
   RETURN QUERY SELECT 'invalid_link'::text,NULL::text,NULL::text;RETURN; END IF;
  UPDATE app.milestone_task_links SET unlinked_at=stamp WHERE milestone_id=target AND unlinked_at IS NULL AND NOT (task_id=ANY(selected));
  INSERT INTO app.milestone_task_links(id,milestone_id,plan_id,client_id,task_id,linked_at)
   SELECT gen_random_uuid(),target,parent,client,v,stamp FROM unnest(selected) v
   WHERE NOT EXISTS(SELECT 1 FROM app.milestone_task_links l WHERE l.milestone_id=target AND l.task_id=v AND l.unlinked_at IS NULL);
  UPDATE app.milestones SET revision=revision+1,updated_at=stamp WHERE id=target;
  RETURN QUERY SELECT 'ok'::text,old_state,old_state;RETURN;
 END IF;
 IF profile IS NULL OR jsonb_typeof(profile)<>'object' OR profile-ARRAY['title','description','start_at','due_at']<>'{}'::jsonb OR
 jsonb_typeof(profile->'title') IS DISTINCT FROM 'string' OR jsonb_typeof(profile->'description') IS DISTINCT FROM 'string' OR
 NOT coalesce(jsonb_typeof(profile->'start_at') IN ('null','string'),false) OR NOT coalesce(jsonb_typeof(profile->'due_at') IN ('null','string'),false) THEN RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text;RETURN; END IF;
 starts:=(profile->>'start_at')::timestamptz;due:=(profile->>'due_at')::timestamptz;
 IF (starts IS NOT NULL AND (NOT isfinite(starts) OR starts<TIMESTAMPTZ '0001-01-01 00:00:00+00' OR starts>=TIMESTAMPTZ '10000-01-01 00:00:00+00')) OR
 (due IS NOT NULL AND (NOT isfinite(due) OR due<TIMESTAMPTZ '0001-01-01 00:00:00+00' OR due>=TIMESTAMPTZ '10000-01-01 00:00:00+00')) THEN RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text;RETURN; END IF;
 IF parent IS NOT NULL THEN
  IF starts IS NOT NULL THEN RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text;RETURN; END IF;
  IF due IS NOT NULL AND ((plan.start_at IS NOT NULL AND due<plan.start_at) OR (plan.due_at IS NOT NULL AND due>plan.due_at)) THEN RETURN QUERY SELECT 'invalid_dates'::text,NULL::text,NULL::text;RETURN; END IF;
 ELSE
  IF (starts IS NOT NULL AND due IS NOT NULL AND due<starts) OR (operation='update' AND EXISTS(SELECT 1 FROM app.milestones m WHERE m.plan_id=target AND m.archived_at IS NULL AND m.due_at IS NOT NULL
   AND ((starts IS NOT NULL AND m.due_at<starts) OR (due IS NOT NULL AND m.due_at>due)))) THEN RETURN QUERY SELECT 'invalid_dates'::text,NULL::text,NULL::text;RETURN; END IF;
 END IF;
 initial:=CASE WHEN parent IS NULL THEN 'draft' ELSE 'planned' END;
 IF operation='create' THEN
  IF parent IS NULL THEN INSERT INTO app.plans(id,client_id,created_by,title,description,status,start_at,due_at) VALUES(target,client,actor,profile->>'title',profile->>'description',initial,starts,due);
  ELSE INSERT INTO app.milestones(id,plan_id,client_id,created_by,title,description,status,due_at) VALUES(target,parent,client,actor,profile->>'title',profile->>'description',initial,due); END IF;
 ELSE
  IF parent IS NULL THEN UPDATE app.plans SET title=profile->>'title',description=profile->>'description',start_at=starts,due_at=due,revision=revision+1,updated_at=stamp WHERE id=target;
  ELSE UPDATE app.milestones SET title=profile->>'title',description=profile->>'description',due_at=due,revision=revision+1,updated_at=stamp WHERE id=target; END IF;
 END IF;
 RETURN QUERY SELECT 'ok'::text,old_state,CASE WHEN operation='create' THEN initial ELSE old_state END;
EXCEPTION WHEN check_violation OR not_null_violation OR invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format OR foreign_key_violation THEN RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text;
 WHEN unique_violation THEN RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text;
END; $$;
-- +goose StatementEnd

-- Add a resource-bound, typed planning marker; never store metadata or task IDs.
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
ALTER TABLE app.audit_events ADD CONSTRAINT audit_planning_snapshot_kind CHECK (
 NOT (before_state ? 'planning_status' OR after_state ? 'planning_status') OR
 (resource_kind='plan' AND coalesce(before_state->>'planning_status','draft') IN ('draft','active','completed','cancelled') AND coalesce(after_state->>'planning_status','draft') IN ('draft','active','completed','cancelled')) OR
 (resource_kind='milestone' AND coalesce(before_state->>'planning_status','planned') IN ('planned','in_progress','completed','cancelled') AND coalesce(after_state->>'planning_status','planned') IN ('planned','in_progress','completed','cancelled')));
REVOKE ALL ON app.plans,app.milestones,app.milestone_task_links FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.planning_transition(text,text,boolean),app.planning_document(uuid,uuid,boolean),
 app.planning_read(uuid,uuid,uuid,uuid),app.planning_list(uuid,uuid,uuid,uuid,integer,text,text,text,boolean),
 app.planning_links(uuid,uuid,uuid,uuid,uuid,integer,text,boolean),app.planning_task_candidates(uuid,uuid,uuid,uuid,integer,text,boolean),
 app.planning_write(uuid,uuid,uuid,uuid,bigint,text,jsonb,text,jsonb) FROM PUBLIC;

-- +goose Down
LOCK TABLE app.plans,app.milestones,app.milestone_task_links,app.tasks,app.role_permissions,app.permissions,app.audit_events IN ACCESS EXCLUSIVE MODE;
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM app.plans) OR EXISTS(SELECT 1 FROM app.milestones) OR EXISTS(SELECT 1 FROM app.milestone_task_links) OR
 EXISTS(SELECT 1 FROM app.audit_events WHERE resource_kind IN ('plan','milestone')) OR
 EXISTS(SELECT 1 FROM app.role_permissions WHERE permission_key IN ('planning.view','planning.create','planning.update','planning.archive') AND
  (NOT seeded OR revoked_at IS NOT NULL OR role_id<>'00000000-0000-4000-8000-000000000001'::uuid)) THEN RAISE EXCEPTION 'Rollback refused: planning or permission history is not empty'; END IF;
END; $$;
-- +goose StatementEnd
DROP FUNCTION app.planning_read(uuid,uuid,uuid,uuid),app.planning_list(uuid,uuid,uuid,uuid,integer,text,text,text,boolean),
 app.planning_links(uuid,uuid,uuid,uuid,uuid,integer,text,boolean),app.planning_task_candidates(uuid,uuid,uuid,uuid,integer,text,boolean),
 app.planning_write(uuid,uuid,uuid,uuid,bigint,text,jsonb,text,jsonb);
DROP FUNCTION app.planning_transition(text,text,boolean),app.planning_document(uuid,uuid,boolean);
DROP TABLE app.milestone_task_links,app.milestones,app.plans;
ALTER TABLE app.tasks DROP CONSTRAINT tasks_id_client_unique;
DELETE FROM app.role_permissions WHERE permission_key IN ('planning.view','planning.create','planning.update','planning.archive');
DELETE FROM app.permissions WHERE permission_key IN ('planning.view','planning.create','planning.update','planning.archive');
ALTER TABLE app.audit_events DROP CONSTRAINT audit_planning_snapshot_kind;
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
