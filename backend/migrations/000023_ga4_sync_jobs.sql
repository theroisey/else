-- +goose Up
-- Existing #26: private, durable GA4 work. No jobs or provider success are seeded.
SELECT pg_advisory_xact_lock(871092650209);

CREATE TABLE app.analytics_sync_jobs (
 id uuid PRIMARY KEY CHECK(id<>'00000000-0000-0000-0000-000000000000'::uuid),
 client_id uuid NOT NULL REFERENCES app.clients(id) ON DELETE RESTRICT,
 connection_id uuid NOT NULL REFERENCES app.integration_connections(id) ON DELETE RESTRICT,
 requested_by uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
 since date NOT NULL CHECK(since>=DATE '2000-01-01' AND since<DATE '10000-01-01'),
 until date NOT NULL CHECK(until>=since AND until-since<=30),
 connection_revision bigint NOT NULL CHECK(connection_revision>0),
 generation bigint NOT NULL CHECK(generation>0),
 credential_revision bigint NOT NULL CHECK(credential_revision>0),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','failed')),
 reason text CHECK(reason IN ('provider_unavailable','authorization_required','connection_changed','interrupted')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 lease_token uuid CHECK(lease_token<>'00000000-0000-0000-0000-000000000000'::uuid),
 lease_until timestamptz,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 CHECK(updated_at>=created_at),
 CHECK((state='running')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK((lease_token IS NULL)=(lease_until IS NULL)),
 CHECK((state IN ('succeeded','failed'))=(finished_at IS NOT NULL)),
 CHECK((state='failed')=(reason IS NOT NULL))
);
CREATE UNIQUE INDEX analytics_sync_one_active ON app.analytics_sync_jobs(connection_id) WHERE state IN ('queued','running');
CREATE INDEX analytics_sync_claim ON app.analytics_sync_jobs(state,lease_until,created_at,id) WHERE state IN ('queued','running');
CREATE INDEX analytics_sync_client_latest ON app.analytics_sync_jobs(client_id,connection_id,created_at DESC,id DESC);

CREATE TABLE app.analytics_snapshots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 client_id uuid NOT NULL REFERENCES app.clients(id) ON DELETE RESTRICT,
 connection_id uuid NOT NULL REFERENCES app.integration_connections(id) ON DELETE RESTRICT,
 generation bigint NOT NULL CHECK(generation>0),
 since date NOT NULL CHECK(since>=DATE '2000-01-01' AND since<DATE '10000-01-01'),
 until date NOT NULL CHECK(until>=since AND until-since<=30),
 workspace jsonb NOT NULL CHECK(jsonb_typeof(workspace)='object' AND octet_length(workspace::text)<=2097152),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 synced_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT analytics_snapshot_period UNIQUE(connection_id,generation,since,until)
);
CREATE INDEX analytics_snapshots_retention ON app.analytics_snapshots(synced_at,id);
CREATE INDEX analytics_snapshots_client_period ON app.analytics_snapshots(client_id,connection_id,since,until,generation);
REVOKE ALL ON app.analytics_sync_jobs,app.analytics_snapshots FROM PUBLIC;

-- +goose StatementBegin
CREATE FUNCTION app.ga4_connection_create(actor uuid,client uuid,connection uuid,account text)
RETURNS TABLE(id uuid,client_id uuid,provider text,state text,revision bigint,created_at timestamptz,updated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR
 NOT app.authorization_allowed(actor,'integrations.manage',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients c WHERE c.id=client AND c.archived_at IS NULL) THEN RAISE no_data_found; END IF;
 IF connection IS NULL OR connection='00000000-0000-0000-0000-000000000000'::uuid OR
 account IS NULL OR NOT app.integration_account_valid('ga4',account) THEN RAISE invalid_parameter_value; END IF;
 BEGIN
  INSERT INTO app.integration_connections(id,client_id,provider,provider_account_id) VALUES(connection,client,'ga4',account);
 EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION USING ERRCODE='P0003',MESSAGE='Integration connection conflict'; END;
 RETURN QUERY SELECT c.id,c.client_id,c.provider,c.state,c.revision,c.created_at,c.updated_at
 FROM app.integration_connections c WHERE c.id=connection AND c.client_id=client;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.ga4_connection_create(uuid,uuid,uuid,text) FROM PUBLIC;

-- Lock order: lifecycle, job admission, connection/job/snapshot rows. The setup
-- transaction calls this before the existing credential writer takes row locks.
-- No transaction/lifecycle lock spans external provider requests.
-- +goose StatementBegin
CREATE FUNCTION app.analytics_writer_lock() RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT pg_advisory_xact_lock_shared(871092650209);
 SELECT pg_advisory_xact_lock(871092650210);
$$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.analytics_writer_lock() FROM PUBLIC;

-- +goose StatementBegin
CREATE FUNCTION app.analytics_sync_enqueue(actor uuid,client uuid,connection uuid,expected_revision bigint,
 expected_generation bigint,expected_credential bigint,since_at date,until_at date,job uuid,credential_changed boolean)
RETURNS TABLE(job_id uuid,connection_revision bigint,job_revision bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE c app.integration_connections; s app.integration_credentials; next_revision bigint;
BEGIN
 PERFORM app.analytics_writer_lock();
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR NOT app.authorization_allowed(actor,'integrations.manage',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients a WHERE a.id=client AND a.archived_at IS NULL) THEN RAISE no_data_found; END IF;
 SELECT * INTO c FROM app.integration_connections a WHERE a.id=connection AND a.client_id=client AND a.provider='ga4'
 AND a.state IN ('pending','connected','reauthorization_required') FOR UPDATE;
 IF NOT FOUND THEN RAISE no_data_found; END IF;
 SELECT * INTO s FROM app.integration_credentials a WHERE a.connection_id=connection;
 IF s.connection_id IS NULL OR s.generation<>c.generation OR c.revision IS DISTINCT FROM expected_revision OR
 c.generation IS DISTINCT FROM expected_generation OR s.revision IS DISTINCT FROM expected_credential OR
 c.revision=9223372036854775807 THEN RAISE EXCEPTION USING ERRCODE='P0003',MESSAGE='Integration synchronization conflict'; END IF;
 IF since_at IS NULL OR until_at IS NULL OR since_at<DATE '2000-01-01' OR until_at>=DATE '10000-01-01' OR
 until_at<since_at OR until_at-since_at>30 OR job IS NULL OR job='00000000-0000-0000-0000-000000000000'::uuid OR
 credential_changed IS NULL THEN RAISE invalid_parameter_value; END IF;
 -- Replacing credentials must atomically interrupt older queued/running work.
 -- It does not mutate those jobs here: require the caller to cancel and audit
 -- them through analytics_sync_cancel before enqueueing this replacement.
 IF EXISTS(SELECT 1 FROM app.analytics_sync_jobs j WHERE j.connection_id=connection AND j.state IN ('queued','running')) THEN
  RAISE EXCEPTION USING ERRCODE='P0003',MESSAGE='Integration synchronization conflict';
 END IF;
 next_revision:=c.revision;
 IF credential_changed THEN
  next_revision:=c.revision+1;
  UPDATE app.integration_connections a SET state='pending',revision=next_revision,updated_at=greatest(clock_timestamp(),a.updated_at) WHERE a.id=connection;
 END IF;
 INSERT INTO app.analytics_sync_jobs(id,client_id,connection_id,requested_by,since,until,connection_revision,generation,credential_revision)
 VALUES(job,client,connection,actor,since_at,until_at,next_revision,c.generation,s.revision);
 RETURN QUERY SELECT job,next_revision,1::bigint;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.analytics_sync_enqueue(uuid,uuid,uuid,bigint,bigint,bigint,date,date,uuid,boolean) FROM PUBLIC;

-- +goose StatementBegin
CREATE FUNCTION app.analytics_sync_cancel(actor uuid,client uuid,connection uuid)
RETURNS TABLE(id uuid,before_revision bigint,after_revision bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
 PERFORM app.analytics_writer_lock();
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR NOT app.authorization_allowed(actor,'integrations.manage',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients a WHERE a.id=client AND a.archived_at IS NULL) OR
 NOT EXISTS(SELECT 1 FROM app.integration_connections c WHERE c.id=connection AND c.client_id=client AND c.provider='ga4'
 AND c.state IN ('pending','connected','reauthorization_required')) THEN RAISE no_data_found; END IF;
 RETURN QUERY UPDATE app.analytics_sync_jobs j SET state='failed',reason='connection_changed',lease_token=NULL,lease_until=NULL,
 finished_at=clock_timestamp(),updated_at=greatest(clock_timestamp(),j.updated_at),revision=j.revision+1
 WHERE j.connection_id=connection AND j.client_id=client AND j.state IN ('queued','running') AND j.revision<9223372036854775807
 RETURNING j.id,j.revision-1,j.revision;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.analytics_sync_cancel(uuid,uuid,uuid) FROM PUBLIC;

-- +goose StatementBegin
CREATE FUNCTION app.analytics_job_allowed(job uuid,token uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 RETURN EXISTS(SELECT 1 FROM app.analytics_sync_jobs j JOIN app.integration_connections c ON c.id=j.connection_id
 JOIN app.integration_credentials s ON s.connection_id=c.id JOIN app.clients a ON a.id=j.client_id
 WHERE j.id=job AND j.state='running' AND j.lease_token=token AND j.lease_until>clock_timestamp() AND a.archived_at IS NULL
 AND c.client_id=j.client_id AND c.provider='ga4' AND c.state IN ('pending','connected','reauthorization_required')
 AND c.revision=j.connection_revision AND c.generation=j.generation AND s.generation=j.generation AND s.revision=j.credential_revision
 AND app.authorization_allowed(j.requested_by,'clients.view',j.client_id) AND app.authorization_allowed(j.requested_by,'integrations.manage',j.client_id));
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.analytics_job_allowed(uuid,uuid) FROM PUBLIC;

-- +goose StatementBegin
CREATE FUNCTION app.analytics_sync_claim()
RETURNS TABLE(job_id uuid,client_id uuid,connection_id uuid,requested_by uuid,since date,until date,state text,
 before_revision bigint,revision bigint,lease_token uuid,property_account text,envelope bytea)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE j app.analytics_sync_jobs; c app.integration_connections; s app.integration_credentials; failure text; next_token uuid;
BEGIN
 PERFORM app.analytics_writer_lock();
 IF (SELECT count(*) FROM app.analytics_sync_jobs a WHERE a.state='running' AND a.lease_until>clock_timestamp())>=2 THEN RETURN; END IF;
 SELECT * INTO j FROM app.analytics_sync_jobs a WHERE a.state='queued' OR (a.state='running' AND a.lease_until<=clock_timestamp())
 ORDER BY a.created_at,a.id LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 IF j.revision=9223372036854775807 THEN RAISE invalid_parameter_value; END IF;
 SELECT * INTO c FROM app.integration_connections a WHERE a.id=j.connection_id FOR UPDATE;
 SELECT * INTO s FROM app.integration_credentials a WHERE a.connection_id=j.connection_id;
 IF NOT app.authorization_allowed(j.requested_by,'clients.view',j.client_id) OR
 NOT app.authorization_allowed(j.requested_by,'integrations.manage',j.client_id) OR
 NOT EXISTS(SELECT 1 FROM app.clients a WHERE a.id=j.client_id AND a.archived_at IS NULL) THEN failure:='authorization_required';
 ELSIF c.client_id IS DISTINCT FROM j.client_id OR c.provider IS DISTINCT FROM 'ga4' OR
 c.state NOT IN ('pending','connected','reauthorization_required') OR c.revision IS DISTINCT FROM j.connection_revision OR
 c.generation IS DISTINCT FROM j.generation OR s.generation IS DISTINCT FROM j.generation OR s.revision IS DISTINCT FROM j.credential_revision THEN failure:='connection_changed';
 ELSIF j.attempts>=3 THEN failure:='interrupted'; END IF;
 IF failure IS NOT NULL THEN
  UPDATE app.analytics_sync_jobs a SET state='failed',reason=failure,lease_token=NULL,lease_until=NULL,
  finished_at=clock_timestamp(),updated_at=greatest(clock_timestamp(),a.updated_at),revision=a.revision+1 WHERE a.id=j.id;
  RETURN QUERY SELECT j.id,j.client_id,j.connection_id,j.requested_by,j.since,j.until,'failed'::text,j.revision,j.revision+1,NULL::uuid,NULL::text,NULL::bytea;
  RETURN;
 END IF;
 next_token:=gen_random_uuid();
 UPDATE app.analytics_sync_jobs a SET state='running',attempts=a.attempts+1,lease_token=next_token,lease_until=clock_timestamp()+INTERVAL '180 seconds',
 updated_at=greatest(clock_timestamp(),a.updated_at),revision=a.revision+1 WHERE a.id=j.id;
 RETURN QUERY SELECT j.id,j.client_id,j.connection_id,j.requested_by,j.since,j.until,'running'::text,j.revision,j.revision+1,next_token,c.provider_account_id,s.envelope;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.analytics_sync_claim() FROM PUBLIC;

-- The public shape has no property/account, credential, unused catalog, raw
-- provider response or diagnostic. These checks also protect direct SQL writers.
-- +goose StatementBegin
CREATE FUNCTION app.analytics_workspace_valid(value jsonb,client uuid,connection uuid,since_at date,until_at date) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE key text; r jsonb; row_value jsonb; column_value jsonb; d jsonb; dimensions jsonb; timezone text; n integer; i integer;
BEGIN
 IF value IS NULL OR jsonb_typeof(value)<>'object' OR octet_length(value::text)>2097152 OR
 value-ARRAY['definitions','summary','daily','acquisition','devices','landing']<>'{}'::jsonb OR
 NOT value ?& ARRAY['definitions','summary','daily','acquisition','devices','landing'] OR
 jsonb_typeof(value->'definitions')<>'array' OR jsonb_array_length(value->'definitions')<>4 THEN RETURN false; END IF;
 FOR i IN 0..3 LOOP
  d:=value->'definitions'->i;
  IF jsonb_typeof(d)<>'object' OR d-ARRAY['name','type','display_name','description']<>'{}'::jsonb OR
  NOT d ?& ARRAY['name','type','display_name','description'] OR
  d->>'name' IS DISTINCT FROM (ARRAY['activeUsers','sessions','screenPageViews','keyEvents'])[i+1] OR
  jsonb_typeof(d->'type')<>'string' OR (i<3 AND d->>'type'<>'TYPE_INTEGER') OR
  (i=3 AND d->>'type' NOT IN ('TYPE_INTEGER','TYPE_FLOAT')) OR
  jsonb_typeof(d->'display_name')<>'string' OR octet_length(d->>'display_name') NOT BETWEEN 1 AND 256 OR
  jsonb_typeof(d->'description')<>'string' OR octet_length(d->>'description') NOT BETWEEN 1 AND 4096 THEN RETURN false; END IF;
 END LOOP;
 timezone:=value->'summary'->>'timezone';
 IF timezone IS NULL OR octet_length(timezone) NOT BETWEEN 1 AND 128 OR timezone='Local' OR
 NOT EXISTS(SELECT 1 FROM pg_timezone_names z WHERE z.name=timezone) THEN RETURN false; END IF;
 FOREACH key IN ARRAY ARRAY['summary','daily','acquisition','devices','landing'] LOOP
  dimensions:=CASE key WHEN 'summary' THEN '[]'::jsonb WHEN 'daily' THEN '["date"]'::jsonb
  WHEN 'acquisition' THEN '["date","sessionDefaultChannelGroup"]'::jsonb WHEN 'devices' THEN '["date","deviceCategory"]'::jsonb ELSE '["landingPage"]'::jsonb END;
  r:=value->key;
  IF jsonb_typeof(r)<>'object' OR r-ARRAY['client_id','connection_id','api_version','timezone','since','until','dimensions','metrics','rows']<>'{}'::jsonb OR
  NOT r ?& ARRAY['client_id','connection_id','api_version','timezone','since','until','dimensions','metrics','rows'] OR
  r->>'client_id' IS DISTINCT FROM client::text OR r->>'connection_id' IS DISTINCT FROM connection::text OR
  r->>'api_version' IS DISTINCT FROM 'v1beta' OR r->>'timezone' IS DISTINCT FROM timezone OR
  r->>'since' IS DISTINCT FROM to_char(since_at,'YYYY-MM-DD') OR r->>'until' IS DISTINCT FROM to_char(until_at,'YYYY-MM-DD') OR
  r->'dimensions' IS DISTINCT FROM dimensions OR r->'metrics' IS DISTINCT FROM '["activeUsers","sessions","screenPageViews","keyEvents"]'::jsonb OR
  jsonb_typeof(r->'rows')<>'array' THEN RETURN false; END IF;
  n:=jsonb_array_length(r->'rows');
  IF n>1000 OR (key='summary' AND n>1) THEN RETURN false; END IF;
  FOR row_value IN SELECT a FROM jsonb_array_elements(r->'rows') a LOOP
   IF jsonb_typeof(row_value)<>'object' OR row_value-ARRAY['dimensions','metrics']<>'{}'::jsonb OR
   NOT row_value ?& ARRAY['dimensions','metrics'] OR jsonb_typeof(row_value->'dimensions')<>'array' OR
   jsonb_array_length(row_value->'dimensions')<>jsonb_array_length(dimensions) OR jsonb_typeof(row_value->'metrics')<>'array' OR
   jsonb_array_length(row_value->'metrics')<>4 THEN RETURN false; END IF;
   FOR i IN 0..3 LOOP
    column_value:=row_value->'metrics'->i;
    IF jsonb_typeof(column_value)<>'string' OR
    (i<3 AND column_value#>>'{}' !~ '^(0|[1-9][0-9]{0,17})$') OR
    (i=3 AND column_value#>>'{}' !~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,18})?$') OR
    (i=3 AND value->'definitions'->i->>'type'='TYPE_INTEGER' AND column_value#>>'{}' !~ '^(0|[1-9][0-9]{0,17})$') THEN RETURN false; END IF;
   END LOOP;
   FOR column_value IN SELECT a FROM jsonb_array_elements(row_value->'dimensions') a LOOP
    IF jsonb_typeof(column_value)<>'string' OR octet_length(column_value#>>'{}')>1024 OR column_value#>>'{}' ~ '[[:cntrl:]]' THEN RETURN false; END IF;
   END LOOP;
   IF key IN ('daily','acquisition','devices') AND
   ((row_value->'dimensions'->>0)!~'^[0-9]{8}$' OR row_value->'dimensions'->>0<to_char(since_at,'YYYYMMDD') OR row_value->'dimensions'->>0>to_char(until_at,'YYYYMMDD')) THEN RETURN false; END IF;
   IF key='landing' AND row_value->'dimensions'->>0<>'(not set)' AND
   (left(row_value->'dimensions'->>0,1)<>'/' OR left(row_value->'dimensions'->>0,2)='//' OR row_value->'dimensions'->>0 ~ '[?#@\\]') THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.analytics_workspace_valid(jsonb,uuid,uuid,date,date) FROM PUBLIC;

-- +goose StatementBegin
CREATE FUNCTION app.analytics_sync_finish(job uuid,token uuid,value jsonb)
RETURNS TABLE(job_id uuid,client_id uuid,connection_id uuid,state text,before_job_revision bigint,job_revision bigint,
 before_connection_revision bigint,connection_revision bigint,snapshot_id uuid,before_snapshot_revision bigint,snapshot_revision bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE j app.analytics_sync_jobs; c app.integration_connections; saved app.analytics_snapshots; failure text; next_connection bigint; now_at timestamptz;
BEGIN
 PERFORM app.analytics_writer_lock();
 SELECT * INTO j FROM app.analytics_sync_jobs a WHERE a.id=job AND a.state='running' AND a.lease_token=token
 AND a.lease_until>clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0003',MESSAGE='Integration synchronization conflict'; END IF;
 IF j.revision=9223372036854775807 THEN RAISE invalid_parameter_value; END IF;
 SELECT * INTO c FROM app.integration_connections a WHERE a.id=j.connection_id FOR UPDATE;
 IF NOT app.analytics_job_allowed(job,token) THEN
  failure:='connection_changed';
  IF NOT app.authorization_allowed(j.requested_by,'clients.view',j.client_id) OR NOT app.authorization_allowed(j.requested_by,'integrations.manage',j.client_id) OR
  NOT EXISTS(SELECT 1 FROM app.clients a WHERE a.id=j.client_id AND a.archived_at IS NULL) THEN failure:='authorization_required'; END IF;
 ELSIF value IS NULL THEN failure:='provider_unavailable';
 ELSIF NOT app.analytics_workspace_valid(value,j.client_id,j.connection_id,j.since,j.until) THEN RAISE invalid_parameter_value;
 END IF;
 now_at:=clock_timestamp(); next_connection:=c.revision;
 IF failure IS NULL THEN
  IF c.revision=9223372036854775807 THEN RAISE invalid_parameter_value; END IF;
  SELECT * INTO saved FROM app.analytics_snapshots a WHERE a.connection_id=j.connection_id AND a.generation=j.generation AND a.since=j.since AND a.until=j.until FOR UPDATE;
  IF saved.revision=9223372036854775807 THEN RAISE invalid_parameter_value; END IF;
  INSERT INTO app.analytics_snapshots(id,client_id,connection_id,generation,since,until,workspace,revision,synced_at)
  VALUES(coalesce(saved.id,gen_random_uuid()),j.client_id,j.connection_id,j.generation,j.since,j.until,value,coalesce(saved.revision,0)+1,now_at)
  ON CONFLICT ON CONSTRAINT analytics_snapshot_period DO UPDATE SET workspace=EXCLUDED.workspace,revision=EXCLUDED.revision,synced_at=EXCLUDED.synced_at;
  next_connection:=c.revision+1;
  UPDATE app.integration_connections a SET state='connected',revision=next_connection,updated_at=greatest(now_at,a.updated_at) WHERE a.id=c.id;
 END IF;
 UPDATE app.analytics_sync_jobs a SET state=CASE WHEN failure IS NULL THEN 'succeeded' ELSE 'failed' END,reason=failure,
 lease_token=NULL,lease_until=NULL,finished_at=now_at,updated_at=greatest(now_at,a.updated_at),revision=a.revision+1 WHERE a.id=j.id;
 RETURN QUERY SELECT j.id,j.client_id,j.connection_id,CASE WHEN failure IS NULL THEN 'succeeded'::text ELSE 'failed'::text END,
 j.revision,j.revision+1,c.revision,next_connection,
 CASE WHEN failure IS NULL THEN (SELECT a.id FROM app.analytics_snapshots a WHERE a.connection_id=j.connection_id AND a.generation=j.generation AND a.since=j.since AND a.until=j.until) ELSE NULL::uuid END,
 CASE WHEN failure IS NULL THEN coalesce(saved.revision,0) ELSE 0::bigint END,
 CASE WHEN failure IS NULL THEN coalesce(saved.revision,0)+1 ELSE 0::bigint END;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.analytics_sync_finish(uuid,uuid,jsonb) FROM PUBLIC;

-- +goose StatementBegin
CREATE FUNCTION app.analytics_workspace_read(actor uuid,client uuid,connection uuid,since_at date,until_at date)
RETURNS TABLE(job_id uuid,job_state text,reason text,job_updated_at timestamptz,last_synced_at timestamptz,workspace jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE c app.integration_connections;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR NOT app.authorization_allowed(actor,'analytics.view',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients a WHERE a.id=client AND a.archived_at IS NULL) THEN RAISE no_data_found; END IF;
 SELECT * INTO c FROM app.integration_connections a WHERE a.id=connection AND a.client_id=client AND a.provider='ga4';
 IF NOT FOUND THEN RAISE no_data_found; END IF;
 IF since_at IS NULL OR until_at IS NULL OR since_at<DATE '2000-01-01' OR until_at>=DATE '10000-01-01' OR until_at<since_at OR until_at-since_at>30 THEN RAISE invalid_parameter_value; END IF;
 RETURN QUERY SELECT j.id,j.state,j.reason,j.updated_at,s.synced_at,s.workspace
 FROM (SELECT 1) one LEFT JOIN LATERAL(SELECT a.id,a.state,a.reason,a.updated_at FROM app.analytics_sync_jobs a
 WHERE a.client_id=client AND a.connection_id=connection AND a.generation=c.generation AND a.since=since_at AND a.until=until_at ORDER BY a.created_at DESC,a.id DESC LIMIT 1) j ON true
 LEFT JOIN LATERAL(SELECT a.synced_at,a.workspace FROM app.analytics_snapshots a WHERE a.client_id=client AND a.connection_id=connection
 AND a.generation=c.generation AND a.since=since_at AND a.until=until_at AND a.synced_at>clock_timestamp()-INTERVAL '90 days'
 AND c.state='connected') s ON true;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.analytics_workspace_read(uuid,uuid,uuid,date,date) FROM PUBLIC;

-- Analytics view independently lists only safe GA4 metadata; it never implies
-- integrations.view/manage or permission to read provider account/credentials.
-- +goose StatementBegin
CREATE FUNCTION app.analytics_connection_list(actor uuid,client uuid,after_id uuid,page_limit integer)
RETURNS TABLE(id uuid,client_id uuid,provider text,state text,revision bigint,created_at timestamptz,updated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR NOT app.authorization_allowed(actor,'analytics.view',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients a WHERE a.id=client AND a.archived_at IS NULL) THEN RAISE no_data_found; END IF;
 IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 26 OR after_id='00000000-0000-0000-0000-000000000000'::uuid THEN RAISE invalid_parameter_value; END IF;
 RETURN QUERY SELECT c.id,c.client_id,c.provider,c.state,c.revision,c.created_at,c.updated_at FROM app.integration_connections c
 WHERE c.client_id=client AND c.provider='ga4' AND (after_id IS NULL OR c.id>after_id) ORDER BY c.id LIMIT page_limit;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.analytics_connection_list(uuid,uuid,uuid,integer) FROM PUBLIC;

-- +goose StatementBegin
CREATE FUNCTION app.analytics_snapshots_prune(page_limit integer)
RETURNS TABLE(id uuid,client_id uuid,revision bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
 PERFORM app.analytics_writer_lock();
 IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 100 THEN RAISE invalid_parameter_value; END IF;
 RETURN QUERY DELETE FROM app.analytics_snapshots a WHERE a.id IN
 (SELECT s.id FROM app.analytics_snapshots s WHERE s.synced_at<=clock_timestamp()-INTERVAL '90 days' ORDER BY s.synced_at,s.id LIMIT page_limit FOR UPDATE)
 RETURNING a.id,a.client_id,a.revision;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.analytics_snapshots_prune(integer) FROM PUBLIC;

-- +goose Down
SELECT pg_advisory_xact_lock(871092650209);
SELECT pg_advisory_xact_lock(871092650210);
LOCK TABLE app.analytics_sync_jobs,app.analytics_snapshots,app.audit_events IN ACCESS EXCLUSIVE MODE;
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM app.analytics_sync_jobs) OR EXISTS(SELECT 1 FROM app.analytics_snapshots) OR
 EXISTS(SELECT 1 FROM app.audit_events WHERE resource_kind IN ('analytics_sync','analytics_snapshot')) THEN
  RAISE EXCEPTION 'Rollback refused: analytics synchronization history is not empty';
 END IF;
END; $$;
-- +goose StatementEnd
DROP FUNCTION app.analytics_snapshots_prune(integer);
DROP FUNCTION app.analytics_connection_list(uuid,uuid,uuid,integer);
DROP FUNCTION app.analytics_workspace_read(uuid,uuid,uuid,date,date);
DROP FUNCTION app.analytics_sync_finish(uuid,uuid,jsonb);
DROP FUNCTION app.analytics_workspace_valid(jsonb,uuid,uuid,date,date);
DROP FUNCTION app.analytics_sync_claim();
DROP FUNCTION app.analytics_job_allowed(uuid,uuid);
DROP FUNCTION app.analytics_sync_cancel(uuid,uuid,uuid);
DROP FUNCTION app.analytics_sync_enqueue(uuid,uuid,uuid,bigint,bigint,bigint,date,date,uuid,boolean);
DROP FUNCTION app.analytics_writer_lock();
DROP FUNCTION app.ga4_connection_create(uuid,uuid,uuid,text);
DROP TABLE app.analytics_snapshots,app.analytics_sync_jobs;
