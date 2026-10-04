-- +goose Up
-- Existing #25: account-calendar reports share the global durable admission.
SELECT pg_advisory_xact_lock(871092650209);
SELECT pg_advisory_xact_lock(871092650210);

ALTER TABLE app.analytics_sync_jobs DROP CONSTRAINT analytics_jobs_provider_period,
 ADD CONSTRAINT analytics_jobs_provider_period CHECK(coalesce(
 (provider IN ('ga4','meta_ads') AND since IS NOT NULL AND until IS NOT NULL AND start_at IS NULL AND end_at IS NULL AND currency IS NULL) OR
 (provider='woocommerce' AND since IS NULL AND until IS NULL AND app.commerce_period_valid(start_at,end_at,currency)),false));
ALTER TABLE app.analytics_snapshots DROP CONSTRAINT analytics_snapshots_provider_period,
 ADD CONSTRAINT analytics_snapshots_provider_period CHECK(coalesce(
 (provider IN ('ga4','meta_ads') AND since IS NOT NULL AND until IS NOT NULL AND start_at IS NULL AND end_at IS NULL AND currency IS NULL) OR
 (provider='woocommerce' AND since IS NULL AND until IS NULL AND app.commerce_period_valid(start_at,end_at,currency)),false));

-- +goose StatementBegin
CREATE FUNCTION app.marketing_connection_create(actor uuid,client uuid,connection uuid,account text)
RETURNS TABLE(id uuid,client_id uuid,provider text,state text,revision bigint,created_at timestamptz,updated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR
 NOT app.authorization_allowed(actor,'integrations.manage',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients c WHERE c.id=client AND c.archived_at IS NULL) THEN RAISE no_data_found; END IF;
 IF connection IS NULL OR connection='00000000-0000-0000-0000-000000000000'::uuid OR
 account IS NULL OR account !~ '^[1-9][0-9]{0,19}$' THEN RAISE invalid_parameter_value; END IF;
 BEGIN
  INSERT INTO app.integration_connections(id,client_id,provider,provider_account_id) VALUES(connection,client,'meta_ads',account);
 EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION USING ERRCODE='P0003',MESSAGE='Integration connection conflict'; END;
 RETURN QUERY SELECT c.id,c.client_id,c.provider,c.state,c.revision,c.created_at,c.updated_at
 FROM app.integration_connections c WHERE c.id=connection AND c.client_id=client;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.marketing_connection_create(uuid,uuid,uuid,text) FROM PUBLIC;

-- +goose StatementBegin
CREATE FUNCTION app.marketing_sync_enqueue(actor uuid,client uuid,connection uuid,expected_revision bigint,
 expected_generation bigint,expected_credential bigint,since_at date,until_at date,job uuid,credential_changed boolean)
RETURNS TABLE(job_id uuid,connection_revision bigint,job_revision bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE c app.integration_connections; s app.integration_credentials; next_revision bigint;
BEGIN
 PERFORM app.analytics_writer_lock();
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR NOT app.authorization_allowed(actor,'integrations.manage',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients a WHERE a.id=client AND a.archived_at IS NULL) THEN RAISE no_data_found; END IF;
 SELECT * INTO c FROM app.integration_connections a WHERE a.id=connection AND a.client_id=client AND a.provider='meta_ads'
 AND a.state IN ('pending','connected','reauthorization_required') FOR UPDATE;
 IF NOT FOUND THEN RAISE no_data_found; END IF;
 SELECT * INTO s FROM app.integration_credentials a WHERE a.connection_id=connection;
 IF s.connection_id IS NULL OR s.generation<>c.generation OR c.revision IS DISTINCT FROM expected_revision OR
 c.generation IS DISTINCT FROM expected_generation OR s.revision IS DISTINCT FROM expected_credential OR
 c.revision=9223372036854775807 THEN RAISE EXCEPTION USING ERRCODE='P0003',MESSAGE='Integration synchronization conflict'; END IF;
 IF c.provider_account_id !~ '^[1-9][0-9]{0,19}$' OR since_at IS NULL OR until_at IS NULL OR since_at<DATE '2000-01-01' OR until_at>=DATE '10000-01-01' OR
 until_at<since_at OR until_at-since_at>30 OR job IS NULL OR job='00000000-0000-0000-0000-000000000000'::uuid OR
 credential_changed IS NULL THEN RAISE invalid_parameter_value; END IF;
 -- Replacing credentials must atomically interrupt older queued/running work.
 -- It does not mutate those jobs here: require the caller to cancel and audit
 -- them through marketing_sync_cancel before enqueueing this replacement.
 IF EXISTS(SELECT 1 FROM app.analytics_sync_jobs j WHERE j.connection_id=connection AND j.state IN ('queued','running')) THEN
  RAISE EXCEPTION USING ERRCODE='P0003',MESSAGE='Integration synchronization conflict';
 END IF;
 next_revision:=c.revision;
 IF credential_changed THEN
  next_revision:=c.revision+1;
  UPDATE app.integration_connections a SET state='pending',revision=next_revision,updated_at=greatest(clock_timestamp(),a.updated_at) WHERE a.id=connection;
 END IF;
 INSERT INTO app.analytics_sync_jobs(id,client_id,connection_id,requested_by,since,until,connection_revision,generation,credential_revision,provider)
 VALUES(job,client,connection,actor,since_at,until_at,next_revision,c.generation,s.revision,'meta_ads');
 RETURN QUERY SELECT job,next_revision,1::bigint;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.marketing_sync_enqueue(uuid,uuid,uuid,bigint,bigint,bigint,date,date,uuid,boolean) FROM PUBLIC;

-- +goose StatementBegin
CREATE FUNCTION app.marketing_sync_cancel(actor uuid,client uuid,connection uuid)
RETURNS TABLE(id uuid,before_revision bigint,after_revision bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
 PERFORM app.analytics_writer_lock();
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR NOT app.authorization_allowed(actor,'integrations.manage',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients a WHERE a.id=client AND a.archived_at IS NULL) OR
 NOT EXISTS(SELECT 1 FROM app.integration_connections c WHERE c.id=connection AND c.client_id=client AND c.provider='meta_ads'
 AND c.state IN ('pending','connected','reauthorization_required')) THEN RAISE no_data_found; END IF;
 RETURN QUERY UPDATE app.analytics_sync_jobs j SET state='failed',reason='connection_changed',lease_token=NULL,lease_until=NULL,
 finished_at=clock_timestamp(),updated_at=greatest(clock_timestamp(),j.updated_at),revision=j.revision+1
 WHERE j.connection_id=connection AND j.client_id=client AND j.state IN ('queued','running') AND j.revision<9223372036854775807
 RETURNING j.id,j.revision-1,j.revision;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.marketing_sync_cancel(uuid,uuid,uuid) FROM PUBLIC;

-- +goose StatementBegin
CREATE FUNCTION app.marketing_workspace_read(actor uuid,client uuid,connection uuid,since_at date,until_at date)
RETURNS TABLE(job_id uuid,job_state text,reason text,job_updated_at timestamptz,last_synced_at timestamptz,workspace jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE c app.integration_connections;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR NOT app.authorization_allowed(actor,'analytics.view',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients a WHERE a.id=client AND a.archived_at IS NULL) THEN RAISE no_data_found; END IF;
 SELECT * INTO c FROM app.integration_connections a WHERE a.id=connection AND a.client_id=client AND a.provider='meta_ads';
 IF NOT FOUND THEN RAISE no_data_found; END IF;
 IF since_at IS NULL OR until_at IS NULL OR since_at<DATE '2000-01-01' OR until_at>=DATE '10000-01-01' OR until_at<since_at OR until_at-since_at>30 THEN RAISE invalid_parameter_value; END IF;
 RETURN QUERY SELECT j.id,j.state,j.reason,j.updated_at,s.synced_at,s.workspace
 FROM (SELECT 1) one LEFT JOIN LATERAL(SELECT a.id,a.state,a.reason,a.updated_at FROM app.analytics_sync_jobs a
 WHERE a.client_id=client AND a.connection_id=connection AND a.generation=c.generation AND a.provider='meta_ads' AND a.since=since_at AND a.until=until_at ORDER BY a.created_at DESC,a.id DESC LIMIT 1) j ON true
 LEFT JOIN LATERAL(SELECT a.synced_at,a.workspace FROM app.analytics_snapshots a WHERE a.client_id=client AND a.connection_id=connection
 AND a.generation=c.generation AND a.provider='meta_ads' AND a.since=since_at AND a.until=until_at AND a.synced_at>clock_timestamp()-INTERVAL '90 days'
 AND c.state='connected') s ON true;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.marketing_workspace_read(uuid,uuid,uuid,date,date) FROM PUBLIC;

-- +goose StatementBegin
CREATE FUNCTION app.marketing_connection_list(actor uuid,client uuid,after_id uuid,page_limit integer)
RETURNS TABLE(id uuid,client_id uuid,provider text,state text,revision bigint,created_at timestamptz,updated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR NOT app.authorization_allowed(actor,'analytics.view',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients a WHERE a.id=client AND a.archived_at IS NULL) THEN RAISE no_data_found; END IF;
 IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 26 OR after_id='00000000-0000-0000-0000-000000000000'::uuid THEN RAISE invalid_parameter_value; END IF;
 RETURN QUERY SELECT c.id,c.client_id,c.provider,c.state,c.revision,c.created_at,c.updated_at FROM app.integration_connections c
 WHERE c.client_id=client AND c.provider='meta_ads' AND (after_id IS NULL OR c.id>after_id) ORDER BY c.id LIMIT page_limit;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.marketing_connection_list(uuid,uuid,uuid,integer) FROM PUBLIC;

-- Exact nonnegative ratios: integer quotient/remainder avoids double rounding.
-- +goose StatementBegin
CREATE FUNCTION app.marketing_ratio(numerator numeric,denominator numeric,multiplier numeric) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN denominator=0 THEN NULL ELSE
 (div(q,1000000))::text||'.'||lpad(mod(q,1000000)::text,6,'0') END
 FROM (SELECT div(numerator*multiplier*1000000,denominator)+
 CASE WHEN mod(numerator*multiplier*1000000,denominator)*2>=denominator THEN 1 ELSE 0 END AS q
 WHERE denominator<>0) exact;
$$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.marketing_ratio(numeric,numeric,numeric) FROM PUBLIC;

-- +goose StatementBegin
CREATE FUNCTION app.marketing_metrics_valid(value jsonb,digits integer) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE spend numeric; impressions numeric; clicks numeric;
BEGIN
 IF value IS NULL OR jsonb_typeof(value)<>'object' OR digits NOT IN (18,20) OR
 value-ARRAY['spend_decimal','impressions','clicks','ctr_percent','cpc_decimal','cpm_decimal']<>'{}'::jsonb OR
 NOT value ?& ARRAY['spend_decimal','impressions','clicks','ctr_percent','cpc_decimal','cpm_decimal'] OR
 jsonb_typeof(value->'spend_decimal')<>'string' OR jsonb_typeof(value->'impressions')<>'string' OR jsonb_typeof(value->'clicks')<>'string' OR
 value->>'spend_decimal' !~ ('^(0|[1-9][0-9]{0,'||(digits-1)::text||'})(\.[0-9]{0,5}[1-9])?$') OR
 value->>'impressions' !~ ('^(0|[1-9][0-9]{0,'||(digits-1)::text||'})$') OR
 value->>'clicks' !~ ('^(0|[1-9][0-9]{0,'||(digits-1)::text||'})$') THEN RETURN false; END IF;
 spend:=(value->>'spend_decimal')::numeric; impressions:=(value->>'impressions')::numeric; clicks:=(value->>'clicks')::numeric;
 RETURN value->'ctr_percent' IS NOT DISTINCT FROM coalesce(to_jsonb(app.marketing_ratio(clicks,impressions,100)),'null'::jsonb) AND
 value->'cpc_decimal' IS NOT DISTINCT FROM coalesce(to_jsonb(app.marketing_ratio(spend,clicks,1)),'null'::jsonb) AND
 value->'cpm_decimal' IS NOT DISTINCT FROM coalesce(to_jsonb(app.marketing_ratio(spend,impressions,1000)),'null'::jsonb);
EXCEPTION WHEN OTHERS THEN RETURN false;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.marketing_metrics_valid(jsonb,integer) FROM PUBLIC;

-- Independent public-shape, binding, calendar, arithmetic and interval checks.
-- +goose StatementBegin
CREATE FUNCTION app.marketing_workspace_valid(value jsonb,client uuid,connection uuid,since_at date,until_at date) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE r jsonb; day jsonb; key text; timestamp_value timestamptz; canonical text;
 collected_from timestamptz; collected_through timestamptz; date_value date; previous_date date;
 spend numeric:=0; impressions numeric:=0; clicks numeric:=0;
BEGIN
 IF value IS NULL OR jsonb_typeof(value)<>'object' OR octet_length(value::text)>2097152 OR
 value-ARRAY['report','collected_from','collected_through']<>'{}'::jsonb OR NOT value ?& ARRAY['report','collected_from','collected_through'] OR
 client IS NULL OR connection IS NULL OR client='00000000-0000-0000-0000-000000000000'::uuid OR connection='00000000-0000-0000-0000-000000000000'::uuid OR
 since_at IS NULL OR until_at IS NULL OR since_at<DATE '2000-01-01' OR until_at>=DATE '10000-01-01' OR until_at<since_at OR until_at-since_at>30 THEN RETURN false; END IF;
 FOREACH key IN ARRAY ARRAY['collected_from','collected_through'] LOOP
  IF jsonb_typeof(value->key)<>'string' OR value->>key !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{0,5}[1-9])?Z$' THEN RETURN false; END IF;
  timestamp_value:=(value->>key)::timestamptz;
  canonical:=to_char(timestamp_value,'YYYY-MM-DD"T"HH24:MI:SS')||
   CASE WHEN to_char(timestamp_value,'US')='000000' THEN '' ELSE '.'||rtrim(to_char(timestamp_value,'US'),'0') END||'Z';
  IF timestamp_value<TIMESTAMPTZ '2000-01-01 00:00:00+00' OR timestamp_value>=TIMESTAMPTZ '10000-01-01 00:00:00+00' OR value->>key<>canonical THEN RETURN false; END IF;
  IF key='collected_from' THEN collected_from:=timestamp_value; ELSE collected_through:=timestamp_value; END IF;
 END LOOP;
 IF collected_through<collected_from OR collected_through-collected_from>INTERVAL '121 seconds' THEN RETURN false; END IF;
 r:=value->'report';
 IF jsonb_typeof(r)<>'object' OR r-ARRAY['client_id','connection_id','graph_version','currency','timezone','since','until','days','totals','attribution_status']<>'{}'::jsonb OR
 NOT r ?& ARRAY['client_id','connection_id','graph_version','currency','timezone','since','until','days','totals','attribution_status'] OR
 r->>'client_id' IS DISTINCT FROM client::text OR r->>'connection_id' IS DISTINCT FROM connection::text OR
 r->>'graph_version' IS DISTINCT FROM 'v26.0' OR r->>'since' IS DISTINCT FROM to_char(since_at,'YYYY-MM-DD') OR r->>'until' IS DISTINCT FROM to_char(until_at,'YYYY-MM-DD') OR
 r->>'attribution_status' IS DISTINCT FROM 'unavailable' OR jsonb_typeof(r->'currency')<>'string' OR r->>'currency' !~ '^[A-Z]{3}$' OR
 jsonb_typeof(r->'timezone')<>'string' OR octet_length(r->>'timezone') NOT BETWEEN 1 AND 128 OR r->>'timezone'='Local' OR
 NOT EXISTS(SELECT 1 FROM pg_timezone_names z WHERE z.name=r->>'timezone') OR
 jsonb_typeof(r->'days')<>'array' OR jsonb_array_length(r->'days')>31 OR NOT app.marketing_metrics_valid(r->'totals',20) THEN RETURN false; END IF;
 FOR day IN SELECT a FROM jsonb_array_elements(r->'days') a LOOP
  IF jsonb_typeof(day)<>'object' OR NOT day ? 'date' OR jsonb_typeof(day->'date')<>'string' OR day->>'date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR
  NOT app.marketing_metrics_valid(day-'date',18) THEN RETURN false; END IF;
  date_value:=(day->>'date')::date;
  IF day->>'date'<>to_char(date_value,'YYYY-MM-DD') OR date_value<since_at OR date_value>until_at OR date_value<=previous_date THEN RETURN false; END IF;
  previous_date:=date_value;
  spend:=spend+(day->>'spend_decimal')::numeric; impressions:=impressions+(day->>'impressions')::numeric; clicks:=clicks+(day->>'clicks')::numeric;
 END LOOP;
 RETURN (r->'totals'->>'spend_decimal')::numeric=spend AND (r->'totals'->>'impressions')::numeric=impressions AND (r->'totals'->>'clicks')::numeric=clicks;
EXCEPTION WHEN OTHERS THEN RETURN false;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.marketing_workspace_valid(jsonb,uuid,uuid,date,date) FROM PUBLIC;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.provider_sync_claim(preferred_provider text)
RETURNS TABLE(job_id uuid,client_id uuid,connection_id uuid,requested_by uuid,since date,until date,provider text,start_at timestamptz,end_at timestamptz,currency text,state text,
 before_revision bigint,revision bigint,lease_token uuid,property_account text,envelope bytea)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE j app.analytics_sync_jobs; c app.integration_connections; s app.integration_credentials; failure text; next_token uuid;
BEGIN
 IF preferred_provider IS NULL OR preferred_provider NOT IN ('ga4','woocommerce','meta_ads') THEN RAISE invalid_parameter_value; END IF;
 PERFORM app.analytics_writer_lock();
 IF (SELECT count(*) FROM app.analytics_sync_jobs a WHERE a.state='running' AND a.lease_until>clock_timestamp())>=2 THEN RETURN; END IF;
 SELECT * INTO j FROM app.analytics_sync_jobs a WHERE a.provider=preferred_provider AND (a.state='queued' OR (a.state='running' AND a.lease_until<=clock_timestamp()))
 ORDER BY a.created_at,a.id LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 IF j.revision=9223372036854775807 THEN RAISE invalid_parameter_value; END IF;
 SELECT * INTO c FROM app.integration_connections a WHERE a.id=j.connection_id FOR UPDATE;
 SELECT * INTO s FROM app.integration_credentials a WHERE a.connection_id=j.connection_id;
 IF NOT app.authorization_allowed(j.requested_by,'clients.view',j.client_id) OR
 NOT app.authorization_allowed(j.requested_by,'integrations.manage',j.client_id) OR
 NOT EXISTS(SELECT 1 FROM app.clients a WHERE a.id=j.client_id AND a.archived_at IS NULL) THEN failure:='authorization_required';
 ELSIF c.client_id IS DISTINCT FROM j.client_id OR c.provider IS DISTINCT FROM j.provider OR
 c.state NOT IN ('pending','connected','reauthorization_required') OR c.revision IS DISTINCT FROM j.connection_revision OR
 c.generation IS DISTINCT FROM j.generation OR s.generation IS DISTINCT FROM j.generation OR s.revision IS DISTINCT FROM j.credential_revision THEN failure:='connection_changed';
 ELSIF j.attempts>=3 THEN failure:='interrupted'; END IF;
 IF failure IS NOT NULL THEN
  UPDATE app.analytics_sync_jobs a SET state='failed',reason=failure,lease_token=NULL,lease_until=NULL,
  finished_at=clock_timestamp(),updated_at=greatest(clock_timestamp(),a.updated_at),revision=a.revision+1 WHERE a.id=j.id;
  RETURN QUERY SELECT j.id,j.client_id,j.connection_id,j.requested_by,j.since,j.until,j.provider,j.start_at,j.end_at,j.currency,'failed'::text,j.revision,j.revision+1,NULL::uuid,NULL::text,NULL::bytea;
  RETURN;
 END IF;
 next_token:=gen_random_uuid();
 UPDATE app.analytics_sync_jobs a SET state='running',attempts=a.attempts+1,lease_token=next_token,lease_until=clock_timestamp()+INTERVAL '180 seconds',
 updated_at=greatest(clock_timestamp(),a.updated_at),revision=a.revision+1 WHERE a.id=j.id;
 RETURN QUERY SELECT j.id,j.client_id,j.connection_id,j.requested_by,j.since,j.until,j.provider,j.start_at,j.end_at,j.currency,'running'::text,j.revision,j.revision+1,next_token,c.provider_account_id,s.envelope;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.provider_sync_claim(text) FROM PUBLIC;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.provider_sync_finish(selected_provider text,job uuid,token uuid,value jsonb)
RETURNS TABLE(job_id uuid,client_id uuid,connection_id uuid,state text,before_job_revision bigint,job_revision bigint,
 before_connection_revision bigint,connection_revision bigint,snapshot_id uuid,before_snapshot_revision bigint,snapshot_revision bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE j app.analytics_sync_jobs; c app.integration_connections; saved app.analytics_snapshots; failure text; next_connection bigint; now_at timestamptz;
BEGIN
 IF selected_provider IS NULL OR selected_provider NOT IN ('ga4','woocommerce','meta_ads') THEN RAISE invalid_parameter_value; END IF;
 PERFORM app.analytics_writer_lock();
 SELECT * INTO j FROM app.analytics_sync_jobs a WHERE a.id=job AND a.provider=selected_provider AND a.state='running' AND a.lease_token=token
 AND a.lease_until>clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0003',MESSAGE='Integration synchronization conflict'; END IF;
 IF j.revision=9223372036854775807 THEN RAISE invalid_parameter_value; END IF;
 SELECT * INTO c FROM app.integration_connections a WHERE a.id=j.connection_id FOR UPDATE;
 IF NOT app.analytics_job_allowed(job,token) THEN
  failure:='connection_changed';
  IF NOT app.authorization_allowed(j.requested_by,'clients.view',j.client_id) OR NOT app.authorization_allowed(j.requested_by,'integrations.manage',j.client_id) OR
  NOT EXISTS(SELECT 1 FROM app.clients a WHERE a.id=j.client_id AND a.archived_at IS NULL) THEN failure:='authorization_required'; END IF;
 ELSIF value IS NULL THEN failure:='provider_unavailable';
 ELSIF (j.provider='ga4' AND NOT app.analytics_workspace_valid(value,j.client_id,j.connection_id,j.since,j.until)) OR
 (j.provider='woocommerce' AND NOT app.commerce_workspace_valid(value,j.client_id,j.connection_id,j.start_at,j.end_at,j.currency)) OR
 (j.provider='meta_ads' AND NOT app.marketing_workspace_valid(value,j.client_id,j.connection_id,j.since,j.until)) THEN RAISE invalid_parameter_value;
 END IF;
 now_at:=clock_timestamp(); next_connection:=c.revision;
 IF failure IS NULL THEN
  IF c.revision=9223372036854775807 THEN RAISE invalid_parameter_value; END IF;
  SELECT * INTO saved FROM app.analytics_snapshots a WHERE a.connection_id=j.connection_id AND a.generation=j.generation AND a.provider=j.provider AND a.since IS NOT DISTINCT FROM j.since AND a.until IS NOT DISTINCT FROM j.until AND a.start_at IS NOT DISTINCT FROM j.start_at AND a.end_at IS NOT DISTINCT FROM j.end_at AND a.currency IS NOT DISTINCT FROM j.currency FOR UPDATE;
  IF saved.revision=9223372036854775807 THEN RAISE invalid_parameter_value; END IF;
  INSERT INTO app.analytics_snapshots(id,client_id,connection_id,generation,since,until,workspace,revision,synced_at,provider,start_at,end_at,currency)
  VALUES(coalesce(saved.id,gen_random_uuid()),j.client_id,j.connection_id,j.generation,j.since,j.until,value,coalesce(saved.revision,0)+1,now_at,j.provider,j.start_at,j.end_at,j.currency)
  ON CONFLICT ON CONSTRAINT analytics_snapshot_period DO UPDATE SET workspace=EXCLUDED.workspace,revision=EXCLUDED.revision,synced_at=EXCLUDED.synced_at;
  next_connection:=c.revision+1;
  UPDATE app.integration_connections a SET state='connected',revision=next_connection,updated_at=greatest(now_at,a.updated_at) WHERE a.id=c.id;
 END IF;
 UPDATE app.analytics_sync_jobs a SET state=CASE WHEN failure IS NULL THEN 'succeeded' ELSE 'failed' END,reason=failure,
 lease_token=NULL,lease_until=NULL,finished_at=now_at,updated_at=greatest(now_at,a.updated_at),revision=a.revision+1 WHERE a.id=j.id;
 RETURN QUERY SELECT j.id,j.client_id,j.connection_id,CASE WHEN failure IS NULL THEN 'succeeded'::text ELSE 'failed'::text END,
 j.revision,j.revision+1,c.revision,next_connection,
 CASE WHEN failure IS NULL THEN (SELECT a.id FROM app.analytics_snapshots a WHERE a.connection_id=j.connection_id AND a.generation=j.generation AND a.provider=j.provider AND a.since IS NOT DISTINCT FROM j.since AND a.until IS NOT DISTINCT FROM j.until AND a.start_at IS NOT DISTINCT FROM j.start_at AND a.end_at IS NOT DISTINCT FROM j.end_at AND a.currency IS NOT DISTINCT FROM j.currency) ELSE NULL::uuid END,
 CASE WHEN failure IS NULL THEN coalesce(saved.revision,0) ELSE 0::bigint END,
 CASE WHEN failure IS NULL THEN coalesce(saved.revision,0)+1 ELSE 0::bigint END;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.provider_sync_finish(text,uuid,uuid,jsonb) FROM PUBLIC;

-- +goose StatementBegin
CREATE FUNCTION app.marketing_sync_finish(job uuid,token uuid,value jsonb)
RETURNS TABLE(job_id uuid,client_id uuid,connection_id uuid,state text,before_job_revision bigint,job_revision bigint,
 before_connection_revision bigint,connection_revision bigint,snapshot_id uuid,before_snapshot_revision bigint,snapshot_revision bigint)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
 SELECT * FROM app.provider_sync_finish('meta_ads',job,token,value);
$$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.marketing_sync_finish(uuid,uuid,jsonb) FROM PUBLIC;

-- +goose Down
SELECT pg_advisory_xact_lock(871092650209);
SELECT pg_advisory_xact_lock(871092650210);
LOCK TABLE app.analytics_sync_jobs,app.analytics_snapshots IN ACCESS EXCLUSIVE MODE;
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM app.analytics_sync_jobs WHERE provider='meta_ads') OR EXISTS(SELECT 1 FROM app.analytics_snapshots WHERE provider='meta_ads') THEN
  RAISE EXCEPTION 'Rollback refused: marketing synchronization history is not empty';
 END IF;
END; $$;
-- +goose StatementEnd
DROP FUNCTION app.marketing_sync_finish(uuid,uuid,jsonb);
DROP FUNCTION app.marketing_workspace_read(uuid,uuid,uuid,date,date);
DROP FUNCTION app.marketing_connection_list(uuid,uuid,uuid,integer);
DROP FUNCTION app.marketing_sync_enqueue(uuid,uuid,uuid,bigint,bigint,bigint,date,date,uuid,boolean);
DROP FUNCTION app.marketing_sync_cancel(uuid,uuid,uuid);
DROP FUNCTION app.marketing_connection_create(uuid,uuid,uuid,text);
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.provider_sync_claim(preferred_provider text)
RETURNS TABLE(job_id uuid,client_id uuid,connection_id uuid,requested_by uuid,since date,until date,provider text,start_at timestamptz,end_at timestamptz,currency text,state text,
 before_revision bigint,revision bigint,lease_token uuid,property_account text,envelope bytea)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE j app.analytics_sync_jobs; c app.integration_connections; s app.integration_credentials; failure text; next_token uuid;
BEGIN
 IF preferred_provider IS NULL OR preferred_provider NOT IN ('ga4','woocommerce') THEN RAISE invalid_parameter_value; END IF;
 PERFORM app.analytics_writer_lock();
 IF (SELECT count(*) FROM app.analytics_sync_jobs a WHERE a.state='running' AND a.lease_until>clock_timestamp())>=2 THEN RETURN; END IF;
 SELECT * INTO j FROM app.analytics_sync_jobs a WHERE a.provider=preferred_provider AND (a.state='queued' OR (a.state='running' AND a.lease_until<=clock_timestamp()))
 ORDER BY a.created_at,a.id LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 IF j.revision=9223372036854775807 THEN RAISE invalid_parameter_value; END IF;
 SELECT * INTO c FROM app.integration_connections a WHERE a.id=j.connection_id FOR UPDATE;
 SELECT * INTO s FROM app.integration_credentials a WHERE a.connection_id=j.connection_id;
 IF NOT app.authorization_allowed(j.requested_by,'clients.view',j.client_id) OR
 NOT app.authorization_allowed(j.requested_by,'integrations.manage',j.client_id) OR
 NOT EXISTS(SELECT 1 FROM app.clients a WHERE a.id=j.client_id AND a.archived_at IS NULL) THEN failure:='authorization_required';
 ELSIF c.client_id IS DISTINCT FROM j.client_id OR c.provider IS DISTINCT FROM j.provider OR
 c.state NOT IN ('pending','connected','reauthorization_required') OR c.revision IS DISTINCT FROM j.connection_revision OR
 c.generation IS DISTINCT FROM j.generation OR s.generation IS DISTINCT FROM j.generation OR s.revision IS DISTINCT FROM j.credential_revision THEN failure:='connection_changed';
 ELSIF j.attempts>=3 THEN failure:='interrupted'; END IF;
 IF failure IS NOT NULL THEN
  UPDATE app.analytics_sync_jobs a SET state='failed',reason=failure,lease_token=NULL,lease_until=NULL,
  finished_at=clock_timestamp(),updated_at=greatest(clock_timestamp(),a.updated_at),revision=a.revision+1 WHERE a.id=j.id;
  RETURN QUERY SELECT j.id,j.client_id,j.connection_id,j.requested_by,j.since,j.until,j.provider,j.start_at,j.end_at,j.currency,'failed'::text,j.revision,j.revision+1,NULL::uuid,NULL::text,NULL::bytea;
  RETURN;
 END IF;
 next_token:=gen_random_uuid();
 UPDATE app.analytics_sync_jobs a SET state='running',attempts=a.attempts+1,lease_token=next_token,lease_until=clock_timestamp()+INTERVAL '180 seconds',
 updated_at=greatest(clock_timestamp(),a.updated_at),revision=a.revision+1 WHERE a.id=j.id;
 RETURN QUERY SELECT j.id,j.client_id,j.connection_id,j.requested_by,j.since,j.until,j.provider,j.start_at,j.end_at,j.currency,'running'::text,j.revision,j.revision+1,next_token,c.provider_account_id,s.envelope;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.provider_sync_claim(text) FROM PUBLIC;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.provider_sync_finish(selected_provider text,job uuid,token uuid,value jsonb)
RETURNS TABLE(job_id uuid,client_id uuid,connection_id uuid,state text,before_job_revision bigint,job_revision bigint,
 before_connection_revision bigint,connection_revision bigint,snapshot_id uuid,before_snapshot_revision bigint,snapshot_revision bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE j app.analytics_sync_jobs; c app.integration_connections; saved app.analytics_snapshots; failure text; next_connection bigint; now_at timestamptz;
BEGIN
 IF selected_provider IS NULL OR selected_provider NOT IN ('ga4','woocommerce') THEN RAISE invalid_parameter_value; END IF;
 PERFORM app.analytics_writer_lock();
 SELECT * INTO j FROM app.analytics_sync_jobs a WHERE a.id=job AND a.provider=selected_provider AND a.state='running' AND a.lease_token=token
 AND a.lease_until>clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0003',MESSAGE='Integration synchronization conflict'; END IF;
 IF j.revision=9223372036854775807 THEN RAISE invalid_parameter_value; END IF;
 SELECT * INTO c FROM app.integration_connections a WHERE a.id=j.connection_id FOR UPDATE;
 IF NOT app.analytics_job_allowed(job,token) THEN
  failure:='connection_changed';
  IF NOT app.authorization_allowed(j.requested_by,'clients.view',j.client_id) OR NOT app.authorization_allowed(j.requested_by,'integrations.manage',j.client_id) OR
  NOT EXISTS(SELECT 1 FROM app.clients a WHERE a.id=j.client_id AND a.archived_at IS NULL) THEN failure:='authorization_required'; END IF;
 ELSIF value IS NULL THEN failure:='provider_unavailable';
 ELSIF (j.provider='ga4' AND NOT app.analytics_workspace_valid(value,j.client_id,j.connection_id,j.since,j.until)) OR
 (j.provider='woocommerce' AND NOT app.commerce_workspace_valid(value,j.client_id,j.connection_id,j.start_at,j.end_at,j.currency)) THEN RAISE invalid_parameter_value;
 END IF;
 now_at:=clock_timestamp(); next_connection:=c.revision;
 IF failure IS NULL THEN
  IF c.revision=9223372036854775807 THEN RAISE invalid_parameter_value; END IF;
  SELECT * INTO saved FROM app.analytics_snapshots a WHERE a.connection_id=j.connection_id AND a.generation=j.generation AND a.provider=j.provider AND a.since IS NOT DISTINCT FROM j.since AND a.until IS NOT DISTINCT FROM j.until AND a.start_at IS NOT DISTINCT FROM j.start_at AND a.end_at IS NOT DISTINCT FROM j.end_at AND a.currency IS NOT DISTINCT FROM j.currency FOR UPDATE;
  IF saved.revision=9223372036854775807 THEN RAISE invalid_parameter_value; END IF;
  INSERT INTO app.analytics_snapshots(id,client_id,connection_id,generation,since,until,workspace,revision,synced_at,provider,start_at,end_at,currency)
  VALUES(coalesce(saved.id,gen_random_uuid()),j.client_id,j.connection_id,j.generation,j.since,j.until,value,coalesce(saved.revision,0)+1,now_at,j.provider,j.start_at,j.end_at,j.currency)
  ON CONFLICT ON CONSTRAINT analytics_snapshot_period DO UPDATE SET workspace=EXCLUDED.workspace,revision=EXCLUDED.revision,synced_at=EXCLUDED.synced_at;
  next_connection:=c.revision+1;
  UPDATE app.integration_connections a SET state='connected',revision=next_connection,updated_at=greatest(now_at,a.updated_at) WHERE a.id=c.id;
 END IF;
 UPDATE app.analytics_sync_jobs a SET state=CASE WHEN failure IS NULL THEN 'succeeded' ELSE 'failed' END,reason=failure,
 lease_token=NULL,lease_until=NULL,finished_at=now_at,updated_at=greatest(now_at,a.updated_at),revision=a.revision+1 WHERE a.id=j.id;
 RETURN QUERY SELECT j.id,j.client_id,j.connection_id,CASE WHEN failure IS NULL THEN 'succeeded'::text ELSE 'failed'::text END,
 j.revision,j.revision+1,c.revision,next_connection,
 CASE WHEN failure IS NULL THEN (SELECT a.id FROM app.analytics_snapshots a WHERE a.connection_id=j.connection_id AND a.generation=j.generation AND a.provider=j.provider AND a.since IS NOT DISTINCT FROM j.since AND a.until IS NOT DISTINCT FROM j.until AND a.start_at IS NOT DISTINCT FROM j.start_at AND a.end_at IS NOT DISTINCT FROM j.end_at AND a.currency IS NOT DISTINCT FROM j.currency) ELSE NULL::uuid END,
 CASE WHEN failure IS NULL THEN coalesce(saved.revision,0) ELSE 0::bigint END,
 CASE WHEN failure IS NULL THEN coalesce(saved.revision,0)+1 ELSE 0::bigint END;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.provider_sync_finish(text,uuid,uuid,jsonb) FROM PUBLIC;

DROP FUNCTION app.marketing_workspace_valid(jsonb,uuid,uuid,date,date);
DROP FUNCTION app.marketing_metrics_valid(jsonb,integer);
DROP FUNCTION app.marketing_ratio(numeric,numeric,numeric);
ALTER TABLE app.analytics_sync_jobs DROP CONSTRAINT analytics_jobs_provider_period,
 ADD CONSTRAINT analytics_jobs_provider_period CHECK(coalesce(
 (provider = 'ga4' AND since IS NOT NULL AND until IS NOT NULL AND start_at IS NULL AND end_at IS NULL AND currency IS NULL) OR
 (provider='woocommerce' AND since IS NULL AND until IS NULL AND app.commerce_period_valid(start_at,end_at,currency)),false));
ALTER TABLE app.analytics_snapshots DROP CONSTRAINT analytics_snapshots_provider_period,
 ADD CONSTRAINT analytics_snapshots_provider_period CHECK(coalesce(
 (provider = 'ga4' AND since IS NOT NULL AND until IS NOT NULL AND start_at IS NULL AND end_at IS NULL AND currency IS NULL) OR
 (provider='woocommerce' AND since IS NULL AND until IS NULL AND app.commerce_period_valid(start_at,end_at,currency)),false));
