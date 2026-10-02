-- +goose Up
-- Earliest due work needs a deadline index; reminder/activity/finance indexes
-- already support their respective projections. No stored aggregate is added.
CREATE INDEX tasks_open_due ON app.tasks(client_id,due_at,id)
 WHERE archived_at IS NULL AND status NOT IN ('done','cancelled') AND due_at IS NOT NULL;

-- One bounded runtime entrypoint. Guarded writers use the exclusive form of
-- this lifecycle lock; shared readers can run together and observe queued
-- revocations before returning any private module data.
-- +goose StatementBegin
CREATE FUNCTION app.client_overview(actor uuid,client uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE result jsonb; module jsonb; sample jsonb; bucket text;
 stamp timestamptz:=statement_timestamp(); horizon timestamptz:=statement_timestamp()+INTERVAL '7 days';
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 IF NOT app.authorization_allowed(actor,'clients.view',client) THEN RAISE no_data_found; END IF;
 SELECT jsonb_build_object('client',jsonb_build_object('id',c.id,'name',c.name,
  'status',CASE WHEN c.archived_at IS NULL THEN 'active' ELSE 'archived' END,'archived_at',c.archived_at),
  'as_of',stamp,'horizon_end',horizon) INTO result FROM app.clients c WHERE c.id=client;
 IF result IS NULL THEN RAISE no_data_found; END IF;

 IF app.authorization_allowed(actor,'billing.view',client) THEN
  SELECT jsonb_build_object('currencies',coalesce(jsonb_agg(v ORDER BY v->>'currency'),'[]'::jsonb))
   INTO module FROM app.billing_summary(actor,client) v;
  result:=result||jsonb_build_object('finance',module);
 END IF;

 IF app.authorization_allowed(actor,'tasks.view',client) THEN
  module:='{}'::jsonb;
  FOREACH bucket IN ARRAY ARRAY['overdue','due_soon'] LOOP
   WITH candidates AS MATERIALIZED (
    SELECT t.id,t.title,t.status,t.priority,t.due_at FROM app.tasks t
    WHERE t.client_id=client AND t.archived_at IS NULL AND t.status NOT IN ('done','cancelled') AND t.due_at IS NOT NULL
     AND t.due_at>CASE WHEN bucket='overdue' THEN '-infinity'::timestamptz ELSE stamp END
     AND t.due_at<=CASE WHEN bucket='overdue' THEN stamp ELSE horizon END
    ORDER BY t.due_at,t.id LIMIT 6
   ) SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.due_at,v.id)
     FROM (SELECT * FROM candidates ORDER BY due_at,id LIMIT 5) v),'[]'::jsonb),
     'has_more',(SELECT count(*)>5 FROM candidates)) INTO sample;
   module:=module||jsonb_build_object(bucket,sample);
  END LOOP;
  result:=result||jsonb_build_object('tasks',module);
 END IF;

 IF app.authorization_allowed(actor,'reminders.view',client) THEN
  module:='{}'::jsonb;
  FOREACH bucket IN ARRAY ARRAY['due','upcoming'] LOOP
   WITH candidates AS MATERIALIZED (
    SELECT r.id,r.title,r.scheduled_at,r.timezone FROM app.reminders r
    WHERE r.client_id=client AND r.status='pending'
     AND r.scheduled_at>CASE WHEN bucket='due' THEN '-infinity'::timestamptz ELSE stamp END
     AND r.scheduled_at<=CASE WHEN bucket='due' THEN stamp ELSE horizon END
    ORDER BY r.scheduled_at,r.id LIMIT 6
   ) SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.scheduled_at,v.id)
     FROM (SELECT * FROM candidates ORDER BY scheduled_at,id LIMIT 5) v),'[]'::jsonb),
     'has_more',(SELECT count(*)>5 FROM candidates)) INTO sample;
   module:=module||jsonb_build_object(bucket,sample);
  END LOOP;
  result:=result||jsonb_build_object('reminders',module);
 END IF;

 IF app.authorization_allowed(actor,'activity.view',client) THEN
  WITH candidates AS MATERIALIZED (SELECT * FROM app.activity_list(actor,client,NULL,NULL,6))
  SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.occurred_at DESC,v.id DESC)
   FROM (SELECT * FROM candidates ORDER BY occurred_at DESC,id DESC LIMIT 5) v),'[]'::jsonb),
   'has_more',(SELECT count(*)>5 FROM candidates)) INTO module;
  result:=result||jsonb_build_object('activity',module);
 END IF;
 RETURN result;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.client_overview(uuid,uuid) FROM PUBLIC;

-- +goose Down
-- Populated business/audit history is untouched by this read-only rollback.
SELECT pg_advisory_xact_lock(871092650209);
DROP FUNCTION app.client_overview(uuid,uuid);
DROP INDEX app.tasks_open_due;
