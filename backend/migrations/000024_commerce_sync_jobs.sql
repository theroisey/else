-- +goose Up
-- Existing #27. Shared durable work and admission; distinct measured periods.
SELECT pg_advisory_xact_lock(871092650209);
SELECT pg_advisory_xact_lock(871092650210);

-- +goose StatementBegin
CREATE FUNCTION app.commerce_period_valid(start_at timestamptz,end_at timestamptz,currency text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog SET timezone='UTC' AS $$
 SELECT coalesce(start_at>=TIMESTAMPTZ '2000-01-01 00:00:00+00' AND end_at<TIMESTAMPTZ '10000-01-01 00:00:00+00'
 AND end_at>start_at AND end_at-start_at<=INTERVAL '31 days'
 AND date_trunc('second',start_at)=start_at AND date_trunc('second',end_at)=end_at
 AND currency IN ('USD','EUR','GBP','TRY','JPY','KWD'),false);
$$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.commerce_period_valid(timestamptz,timestamptz,text) FROM PUBLIC;

ALTER TABLE app.analytics_sync_jobs
 ADD COLUMN provider text NOT NULL DEFAULT 'ga4',
 ADD COLUMN start_at timestamptz, ADD COLUMN end_at timestamptz, ADD COLUMN currency text,
 ALTER COLUMN since DROP NOT NULL, ALTER COLUMN until DROP NOT NULL,
 ADD CONSTRAINT analytics_jobs_provider_period CHECK(coalesce(
 (provider='ga4' AND since IS NOT NULL AND until IS NOT NULL AND start_at IS NULL AND end_at IS NULL AND currency IS NULL) OR
 (provider='woocommerce' AND since IS NULL AND until IS NULL AND app.commerce_period_valid(start_at,end_at,currency)),false));
ALTER TABLE app.analytics_snapshots
 ADD COLUMN provider text NOT NULL DEFAULT 'ga4',
 ADD COLUMN start_at timestamptz, ADD COLUMN end_at timestamptz, ADD COLUMN currency text,
 ALTER COLUMN since DROP NOT NULL, ALTER COLUMN until DROP NOT NULL,
 ADD CONSTRAINT analytics_snapshots_provider_period CHECK(coalesce(
 (provider='ga4' AND since IS NOT NULL AND until IS NOT NULL AND start_at IS NULL AND end_at IS NULL AND currency IS NULL) OR
 (provider='woocommerce' AND since IS NULL AND until IS NULL AND app.commerce_period_valid(start_at,end_at,currency)),false)),
 DROP CONSTRAINT analytics_snapshot_period,
 ADD CONSTRAINT analytics_snapshot_period UNIQUE NULLS NOT DISTINCT(connection_id,generation,provider,since,until,start_at,end_at,currency);
CREATE INDEX analytics_jobs_provider_claim ON app.analytics_sync_jobs(provider,state,lease_until,created_at,id) WHERE state IN ('queued','running');
CREATE INDEX commerce_jobs_client_period ON app.analytics_sync_jobs(client_id,connection_id,generation,start_at,end_at,currency,created_at DESC,id DESC) WHERE provider='woocommerce';
CREATE INDEX commerce_snapshots_client_period ON app.analytics_snapshots(client_id,connection_id,generation,start_at,end_at,currency) WHERE provider='woocommerce';

-- +goose StatementBegin
CREATE FUNCTION app.commerce_connection_create(actor uuid,client uuid,connection uuid,account text)
RETURNS TABLE(id uuid,client_id uuid,provider text,state text,revision bigint,created_at timestamptz,updated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR
 NOT app.authorization_allowed(actor,'integrations.manage',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients c WHERE c.id=client AND c.archived_at IS NULL) THEN RAISE no_data_found; END IF;
 IF connection IS NULL OR connection='00000000-0000-0000-0000-000000000000'::uuid OR
 account IS NULL OR NOT app.integration_account_valid('woocommerce',account) THEN RAISE invalid_parameter_value; END IF;
 BEGIN
  INSERT INTO app.integration_connections(id,client_id,provider,provider_account_id) VALUES(connection,client,'woocommerce',account);
 EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION USING ERRCODE='P0003',MESSAGE='Integration connection conflict'; END;
 RETURN QUERY SELECT c.id,c.client_id,c.provider,c.state,c.revision,c.created_at,c.updated_at
 FROM app.integration_connections c WHERE c.id=connection AND c.client_id=client;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.commerce_connection_create(uuid,uuid,uuid,text) FROM PUBLIC;
-- +goose StatementBegin
CREATE FUNCTION app.commerce_sync_enqueue(actor uuid,client uuid,connection uuid,expected_revision bigint,
 expected_generation bigint,expected_credential bigint,start_at timestamptz,end_at timestamptz,currency_code text,job uuid,credential_changed boolean)
RETURNS TABLE(job_id uuid,connection_revision bigint,job_revision bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE c app.integration_connections; s app.integration_credentials; next_revision bigint;
BEGIN
 PERFORM app.analytics_writer_lock();
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR NOT app.authorization_allowed(actor,'integrations.manage',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients a WHERE a.id=client AND a.archived_at IS NULL) THEN RAISE no_data_found; END IF;
 SELECT * INTO c FROM app.integration_connections a WHERE a.id=connection AND a.client_id=client AND a.provider='woocommerce'
 AND a.state IN ('pending','connected','reauthorization_required') FOR UPDATE;
 IF NOT FOUND THEN RAISE no_data_found; END IF;
 SELECT * INTO s FROM app.integration_credentials a WHERE a.connection_id=connection;
 IF s.connection_id IS NULL OR s.generation<>c.generation OR c.revision IS DISTINCT FROM expected_revision OR
 c.generation IS DISTINCT FROM expected_generation OR s.revision IS DISTINCT FROM expected_credential OR
 c.revision=9223372036854775807 THEN RAISE EXCEPTION USING ERRCODE='P0003',MESSAGE='Integration synchronization conflict'; END IF;
 IF NOT app.commerce_period_valid(start_at,end_at,currency_code) OR job IS NULL OR job='00000000-0000-0000-0000-000000000000'::uuid OR
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
 INSERT INTO app.analytics_sync_jobs(id,client_id,connection_id,requested_by,since,until,connection_revision,generation,credential_revision,provider,start_at,end_at,currency)
 VALUES(job,client,connection,actor,NULL,NULL,next_revision,c.generation,s.revision,'woocommerce',start_at,end_at,currency_code);
 RETURN QUERY SELECT job,next_revision,1::bigint;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.commerce_sync_enqueue(uuid,uuid,uuid,bigint,bigint,bigint,timestamptz,timestamptz,text,uuid,boolean) FROM PUBLIC;
-- +goose StatementBegin
CREATE FUNCTION app.commerce_sync_cancel(actor uuid,client uuid,connection uuid)
RETURNS TABLE(id uuid,before_revision bigint,after_revision bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
 PERFORM app.analytics_writer_lock();
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR NOT app.authorization_allowed(actor,'integrations.manage',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients a WHERE a.id=client AND a.archived_at IS NULL) OR
 NOT EXISTS(SELECT 1 FROM app.integration_connections c WHERE c.id=connection AND c.client_id=client AND c.provider='woocommerce'
 AND c.state IN ('pending','connected','reauthorization_required')) THEN RAISE no_data_found; END IF;
 RETURN QUERY UPDATE app.analytics_sync_jobs j SET state='failed',reason='connection_changed',lease_token=NULL,lease_until=NULL,
 finished_at=clock_timestamp(),updated_at=greatest(clock_timestamp(),j.updated_at),revision=j.revision+1
 WHERE j.connection_id=connection AND j.client_id=client AND j.state IN ('queued','running') AND j.revision<9223372036854775807
 RETURNING j.id,j.revision-1,j.revision;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.commerce_sync_cancel(uuid,uuid,uuid) FROM PUBLIC;
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.analytics_job_allowed(job uuid,token uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 RETURN EXISTS(SELECT 1 FROM app.analytics_sync_jobs j JOIN app.integration_connections c ON c.id=j.connection_id
 JOIN app.integration_credentials s ON s.connection_id=c.id JOIN app.clients a ON a.id=j.client_id
 WHERE j.id=job AND j.state='running' AND j.lease_token=token AND j.lease_until>clock_timestamp() AND a.archived_at IS NULL
 AND c.client_id=j.client_id AND c.provider=j.provider AND c.state IN ('pending','connected','reauthorization_required')
 AND c.revision=j.connection_revision AND c.generation=j.generation AND s.generation=j.generation AND s.revision=j.credential_revision
 AND app.authorization_allowed(j.requested_by,'clients.view',j.client_id) AND app.authorization_allowed(j.requested_by,'integrations.manage',j.client_id));
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.analytics_job_allowed(uuid,uuid) FROM PUBLIC;
-- +goose StatementBegin
CREATE FUNCTION app.provider_sync_claim(preferred_provider text)
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
-- Existing GA4 entrypoint remains provider-specific.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.analytics_sync_claim()
RETURNS TABLE(job_id uuid,client_id uuid,connection_id uuid,requested_by uuid,since date,until date,state text,
 before_revision bigint,revision bigint,lease_token uuid,property_account text,envelope bytea)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
 SELECT a.job_id,a.client_id,a.connection_id,a.requested_by,a.since,a.until,a.state,a.before_revision,a.revision,a.lease_token,a.property_account,a.envelope
 FROM app.provider_sync_claim('ga4') a;
$$;
-- +goose StatementEnd


-- Validate the minimal public shape independently of Go. No expanded provider
-- object, account, key, customer data or unconstrained exact decimal is stored.
-- +goose StatementBegin
CREATE FUNCTION app.commerce_workspace_valid(value jsonb,client uuid,connection uuid,start_at timestamptz,end_at timestamptz,currency text) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE report jsonb; row_value jsonb; key text; name text; rows_key text; keys text[]; row_keys text[];
 exponent integer; first_at timestamptz; last_at timestamptz; created timestamptz; field text;
 orders_count integer; total_lines integer:=0; orders_ids numeric[]:=ARRAY[]::numeric[];
 previous numeric; current_id numeric; parent numeric; product numeric; variation numeric;
 previous_product numeric:=-1; previous_variation numeric:=-1; quantity numeric; order_count integer; line_count integer;
 grand numeric:=0; refunded numeric:=0; remainder numeric:=0; refund_events numeric:=0;
 row_grand numeric; row_refunded numeric; row_remainder numeric; net numeric; tax numeric; line_grand numeric;
BEGIN
 IF NOT app.commerce_period_valid(start_at,end_at,currency) OR client IS NULL OR connection IS NULL OR
 value IS NULL OR jsonb_typeof(value)<>'object' OR octet_length(value::text)>2097152 OR
 value-ARRAY['orders','refunds','products','collected_from','collected_through']<>'{}'::jsonb OR
 NOT value ?& ARRAY['orders','refunds','products','collected_from','collected_through'] THEN RETURN false; END IF;
 FOREACH key IN ARRAY ARRAY['collected_from','collected_through'] LOOP
  IF jsonb_typeof(value->key)<>'string' OR value->>key !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$' THEN RETURN false; END IF;
  created:=(value->>key)::timestamptz;
  field:=to_char(created,'YYYY-MM-DD"T"HH24:MI:SS') || CASE WHEN extract(microseconds FROM created)::bigint%1000000=0 THEN ''
   ELSE '.' || rtrim(to_char(created,'US'),'0') END || 'Z';
  IF field IS DISTINCT FROM value->>key OR created<TIMESTAMPTZ '2000-01-01' OR created>=TIMESTAMPTZ '10000-01-01' THEN RETURN false; END IF;
 END LOOP;
 first_at:=(value->>'collected_from')::timestamptz; last_at:=(value->>'collected_through')::timestamptz;
 IF last_at<first_at OR last_at-first_at>INTERVAL '121 seconds' THEN RETURN false; END IF;
 exponent:=CASE currency WHEN 'JPY' THEN 0 WHEN 'KWD' THEN 3 ELSE 2 END;
 FOREACH name IN ARRAY ARRAY['orders','refunds','products'] LOOP
  report:=value->name; rows_key:=name;
  keys:=ARRAY['client_id','connection_id','api_version','currency','currency_exponent','start','end',rows_key];
  IF name='orders' THEN keys:=keys || ARRAY['grand_total_minor','lifetime_refund_minor','remainder_minor'];
  ELSIF name='refunds' THEN keys:=keys || ARRAY['amount_minor']; END IF;
  IF jsonb_typeof(report)<>'object' OR report-keys<>'{}'::jsonb OR NOT report ?& keys OR
  report->>'client_id' IS DISTINCT FROM client::text OR report->>'connection_id' IS DISTINCT FROM connection::text OR
  report->>'api_version' IS DISTINCT FROM 'wc/v3' OR report->>'currency' IS DISTINCT FROM currency OR
  report->'currency_exponent' IS DISTINCT FROM to_jsonb(exponent) OR
  report->>'start' IS DISTINCT FROM to_char(start_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') OR
  report->>'end' IS DISTINCT FROM to_char(end_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') OR
  jsonb_typeof(report->rows_key)<>'array' THEN RETURN false; END IF;
  IF jsonb_array_length(report->rows_key)>(CASE name WHEN 'products' THEN 1000 ELSE 500 END) THEN RETURN false; END IF;
  IF name='orders' THEN orders_count:=jsonb_array_length(report->rows_key); END IF;
  FOREACH key IN ARRAY keys LOOP
   IF key IN ('client_id','connection_id','api_version','currency','start','end') AND jsonb_typeof(report->key)<>'string' THEN RETURN false; END IF;
   IF key IN ('grand_total_minor','lifetime_refund_minor','remainder_minor','amount_minor') AND
   (jsonb_typeof(report->key)<>'string' OR report->>key !~ '^(0|[1-9][0-9]{0,23})$') THEN RETURN false; END IF;
  END LOOP;
  previous:=0;
  FOR row_value IN SELECT a FROM jsonb_array_elements(report->rows_key) a LOOP
   row_keys:=CASE name WHEN 'orders' THEN ARRAY['id','status','created_at','grand_total_minor','lifetime_refund_minor','remainder_minor']
   WHEN 'refunds' THEN ARRAY['id','parent_id','created_at','amount_minor']
   ELSE ARRAY['product_id','variation_id','quantity','order_count','line_count','total_minor','tax_minor','line_grand_minor'] END;
   IF jsonb_typeof(row_value)<>'object' OR row_value-row_keys<>'{}'::jsonb OR NOT row_value ?& row_keys THEN RETURN false; END IF;
   FOREACH key IN ARRAY row_keys LOOP
    IF jsonb_typeof(row_value->key)<>'string' THEN RETURN false; END IF;
    IF key NOT IN ('status','created_at') AND row_value->>key !~ '^(0|[1-9][0-9]{0,22})$' THEN RETURN false; END IF;
    IF key IN ('id','parent_id') AND row_value->>key !~ '^[1-9][0-9]{0,17}$' THEN RETURN false; END IF;
    IF key IN ('product_id','variation_id') AND length(row_value->>key)>18 THEN RETURN false; END IF;
   END LOOP;
   IF name IN ('orders','refunds') THEN
    current_id:=(row_value->>'id')::numeric;
    IF current_id<=previous OR row_value->>'created_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' THEN RETURN false; END IF;
    previous:=current_id; created:=(row_value->>'created_at')::timestamptz;
    IF to_char(created,'YYYY-MM-DD"T"HH24:MI:SS"Z"') IS DISTINCT FROM row_value->>'created_at' OR created<start_at OR created>=end_at THEN RETURN false; END IF;
   END IF;
   IF name='orders' THEN
    IF row_value->>'status' NOT IN ('pending','processing','on-hold','completed','cancelled','refunded','failed','trash') OR
    length(row_value->>'grand_total_minor')>18 OR length(row_value->>'lifetime_refund_minor')>20 OR length(row_value->>'remainder_minor')>18 THEN RETURN false; END IF;
    row_grand:=(row_value->>'grand_total_minor')::numeric; row_refunded:=(row_value->>'lifetime_refund_minor')::numeric; row_remainder:=(row_value->>'remainder_minor')::numeric;
    IF row_grand<>row_refunded+row_remainder THEN RETURN false; END IF;
    grand:=grand+row_grand; refunded:=refunded+row_refunded; remainder:=remainder+row_remainder; orders_ids:=array_append(orders_ids,current_id);
   ELSIF name='refunds' THEN
    parent:=(row_value->>'parent_id')::numeric;
    IF current_id=parent OR current_id=ANY(orders_ids) OR length(row_value->>'amount_minor')>18 THEN RETURN false; END IF;
    refund_events:=refund_events+(row_value->>'amount_minor')::numeric;
   ELSE
    product:=(row_value->>'product_id')::numeric; variation:=(row_value->>'variation_id')::numeric;
    quantity:=(row_value->>'quantity')::numeric; order_count:=(row_value->>'order_count')::integer; line_count:=(row_value->>'line_count')::integer;
    net:=(row_value->>'total_minor')::numeric; tax:=(row_value->>'tax_minor')::numeric; line_grand:=(row_value->>'line_grand_minor')::numeric;
    IF product<previous_product OR (product=previous_product AND variation<=previous_variation) OR quantity<=0 OR
    length(row_value->>'order_count')>3 OR length(row_value->>'line_count')>5 OR order_count<1 OR order_count>orders_count OR
    line_count<order_count OR line_count>order_count*50 OR quantity<line_count OR quantity>line_count::numeric*999999999999999999 OR
    net>line_count::numeric*999999999999999999 OR tax>line_count::numeric*999999999999999999 OR line_grand<>net+tax THEN RETURN false; END IF;
    total_lines:=total_lines+line_count; previous_product:=product; previous_variation:=variation;
   END IF;
  END LOOP;
 END LOOP;
 RETURN grand::text=value->'orders'->>'grand_total_minor' AND refunded::text=value->'orders'->>'lifetime_refund_minor'
 AND remainder::text=value->'orders'->>'remainder_minor' AND refund_events::text=value->'refunds'->>'amount_minor'
 AND total_lines<=orders_count*50;
EXCEPTION WHEN OTHERS THEN RETURN false;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.commerce_workspace_valid(jsonb,uuid,uuid,timestamptz,timestamptz,text) FROM PUBLIC;

-- +goose StatementBegin
CREATE FUNCTION app.provider_sync_finish(selected_provider text,job uuid,token uuid,value jsonb)
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
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.analytics_sync_finish(job uuid,token uuid,value jsonb)
RETURNS TABLE(job_id uuid,client_id uuid,connection_id uuid,state text,before_job_revision bigint,job_revision bigint,
 before_connection_revision bigint,connection_revision bigint,snapshot_id uuid,before_snapshot_revision bigint,snapshot_revision bigint)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
 SELECT * FROM app.provider_sync_finish('ga4',job,token,value);
$$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.analytics_sync_finish(uuid,uuid,jsonb) FROM PUBLIC;

-- +goose StatementBegin
CREATE FUNCTION app.commerce_sync_finish(job uuid,token uuid,value jsonb)
RETURNS TABLE(job_id uuid,client_id uuid,connection_id uuid,state text,before_job_revision bigint,job_revision bigint,
 before_connection_revision bigint,connection_revision bigint,snapshot_id uuid,before_snapshot_revision bigint,snapshot_revision bigint)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
 SELECT * FROM app.provider_sync_finish('woocommerce',job,token,value);
$$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.commerce_sync_finish(uuid,uuid,jsonb) FROM PUBLIC;

-- +goose StatementBegin
CREATE FUNCTION app.commerce_workspace_read(actor uuid,client uuid,connection uuid,start_value timestamptz,end_value timestamptz,currency_code text)
RETURNS TABLE(job_id uuid,job_state text,reason text,job_updated_at timestamptz,last_synced_at timestamptz,workspace jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE c app.integration_connections;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR NOT app.authorization_allowed(actor,'analytics.view',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients a WHERE a.id=client AND a.archived_at IS NULL) THEN RAISE no_data_found; END IF;
 SELECT * INTO c FROM app.integration_connections a WHERE a.id=connection AND a.client_id=client AND a.provider='woocommerce';
 IF NOT FOUND THEN RAISE no_data_found; END IF;
 IF NOT app.commerce_period_valid(start_value,end_value,currency_code) THEN RAISE invalid_parameter_value; END IF;
 RETURN QUERY SELECT j.id,j.state,j.reason,j.updated_at,s.synced_at,s.workspace
 FROM (SELECT 1) one LEFT JOIN LATERAL(SELECT a.id,a.state,a.reason,a.updated_at FROM app.analytics_sync_jobs a
 WHERE a.client_id=client AND a.connection_id=connection AND a.generation=c.generation AND a.provider='woocommerce' AND a.start_at=start_value AND a.end_at=end_value AND a.currency=currency_code ORDER BY a.created_at DESC,a.id DESC LIMIT 1) j ON true
 LEFT JOIN LATERAL(SELECT a.synced_at,a.workspace FROM app.analytics_snapshots a WHERE a.client_id=client AND a.connection_id=connection
 AND a.generation=c.generation AND a.provider='woocommerce' AND a.start_at=start_value AND a.end_at=end_value AND a.currency=currency_code AND a.synced_at>clock_timestamp()-INTERVAL '90 days'
 AND c.state='connected') s ON true;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.commerce_workspace_read(uuid,uuid,uuid,timestamptz,timestamptz,text) FROM PUBLIC;
-- +goose StatementBegin
CREATE FUNCTION app.commerce_connection_list(actor uuid,client uuid,after_id uuid,page_limit integer)
RETURNS TABLE(id uuid,client_id uuid,provider text,state text,revision bigint,created_at timestamptz,updated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 IF NOT app.authorization_allowed(actor,'clients.view',client) OR NOT app.authorization_allowed(actor,'analytics.view',client) OR
 NOT EXISTS(SELECT 1 FROM app.clients a WHERE a.id=client AND a.archived_at IS NULL) THEN RAISE no_data_found; END IF;
 IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 26 OR after_id='00000000-0000-0000-0000-000000000000'::uuid THEN RAISE invalid_parameter_value; END IF;
 RETURN QUERY SELECT c.id,c.client_id,c.provider,c.state,c.revision,c.created_at,c.updated_at FROM app.integration_connections c
 WHERE c.client_id=client AND c.provider='woocommerce' AND (after_id IS NULL OR c.id>after_id) ORDER BY c.id LIMIT page_limit;
END; $$;
-- +goose StatementEnd
REVOKE EXECUTE ON FUNCTION app.commerce_connection_list(uuid,uuid,uuid,integer) FROM PUBLIC;

-- +goose Down
SELECT pg_advisory_xact_lock(871092650209);
SELECT pg_advisory_xact_lock(871092650210);
LOCK TABLE app.analytics_sync_jobs,app.analytics_snapshots IN ACCESS EXCLUSIVE MODE;
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM app.analytics_sync_jobs WHERE provider<>'ga4') OR EXISTS(SELECT 1 FROM app.analytics_snapshots WHERE provider<>'ga4') THEN
  RAISE EXCEPTION 'Rollback refused: commerce synchronization history is not empty';
 END IF;
END; $$;
-- +goose StatementEnd
DROP FUNCTION app.commerce_connection_list(uuid,uuid,uuid,integer);
DROP FUNCTION app.commerce_workspace_read(uuid,uuid,uuid,timestamptz,timestamptz,text);
DROP FUNCTION app.commerce_sync_finish(uuid,uuid,jsonb);
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.analytics_sync_claim()
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

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.analytics_job_allowed(job uuid,token uuid) RETURNS boolean
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
CREATE OR REPLACE FUNCTION app.analytics_sync_finish(job uuid,token uuid,value jsonb)
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

DROP FUNCTION app.provider_sync_finish(text,uuid,uuid,jsonb);
DROP FUNCTION app.provider_sync_claim(text);
DROP FUNCTION app.commerce_sync_cancel(uuid,uuid,uuid);
DROP FUNCTION app.commerce_sync_enqueue(uuid,uuid,uuid,bigint,bigint,bigint,timestamptz,timestamptz,text,uuid,boolean);
DROP FUNCTION app.commerce_connection_create(uuid,uuid,uuid,text);
DROP FUNCTION app.commerce_workspace_valid(jsonb,uuid,uuid,timestamptz,timestamptz,text);
DROP INDEX app.commerce_snapshots_client_period;
DROP INDEX app.commerce_jobs_client_period;
DROP INDEX app.analytics_jobs_provider_claim;
ALTER TABLE app.analytics_snapshots DROP CONSTRAINT analytics_snapshot_period, DROP CONSTRAINT analytics_snapshots_provider_period,
 DROP COLUMN provider,DROP COLUMN start_at,DROP COLUMN end_at,DROP COLUMN currency,
 ALTER COLUMN since SET NOT NULL,ALTER COLUMN until SET NOT NULL,
 ADD CONSTRAINT analytics_snapshot_period UNIQUE(connection_id,generation,since,until);
ALTER TABLE app.analytics_sync_jobs DROP CONSTRAINT analytics_jobs_provider_period,
 DROP COLUMN provider,DROP COLUMN start_at,DROP COLUMN end_at,DROP COLUMN currency,
 ALTER COLUMN since SET NOT NULL,ALTER COLUMN until SET NOT NULL;
DROP FUNCTION app.commerce_period_valid(timestamptz,timestamptz,text);
