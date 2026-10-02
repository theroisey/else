-- +goose Up
INSERT INTO app.permissions(permission_key,scope_kind,description) VALUES
 ('billing.create','client','Create client collections'),
 ('billing.update','client','Edit collections and record payments'),
 ('billing.delete','client','Cancel unsettled collections with retained history');
INSERT INTO app.role_permissions(id,role_id,permission_key,seeded)
 SELECT gen_random_uuid(),'00000000-0000-4000-8000-000000000001'::uuid,permission_key,true
 FROM app.permissions WHERE permission_key IN ('billing.create','billing.update','billing.delete');
CREATE TABLE app.billing_currencies (
 code text PRIMARY KEY CHECK(code IN ('USD','EUR','GBP','TRY','JPY','KWD')),
 exponent smallint NOT NULL CHECK(exponent=CASE code WHEN 'JPY' THEN 0 WHEN 'KWD' THEN 3 ELSE 2 END),
 UNIQUE(code,exponent)
);
INSERT INTO app.billing_currencies VALUES ('USD',2),('EUR',2),('GBP',2),('TRY',2),('JPY',0),('KWD',3);
CREATE TABLE app.collections (
 id uuid PRIMARY KEY CHECK(id<>'00000000-0000-0000-0000-000000000000'),
 client_id uuid NOT NULL REFERENCES app.clients(id),
 created_by uuid NOT NULL REFERENCES app.users(id),
 description text NOT NULL CHECK(char_length(description) BETWEEN 1 AND 2000 AND description=btrim(description) AND replace(description,E'\n','')!~'[[:cntrl:]]'),
 internal_note text NOT NULL DEFAULT '' CHECK(char_length(internal_note)<=8000 AND replace(internal_note,E'\n','')!~'[[:cntrl:]]'),
 amount_minor bigint NOT NULL CHECK(amount_minor>0),
 paid_minor bigint NOT NULL DEFAULT 0 CHECK(paid_minor>=0 AND paid_minor<=amount_minor),
 currency text NOT NULL,
 currency_exponent smallint NOT NULL,
 due_date date CHECK(due_date IS NULL OR due_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 cancelled_at timestamptz,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(currency,currency_exponent) REFERENCES app.billing_currencies(code,exponent),
 UNIQUE(id,client_id,currency),
 CHECK(updated_at>=created_at AND (cancelled_at IS NULL OR cancelled_at>=created_at)),
 CHECK(cancelled_at IS NULL OR paid_minor<amount_minor)
);
CREATE INDEX collections_client_id ON app.collections(client_id,id);
CREATE INDEX collections_client_currency_id ON app.collections(client_id,currency,id);
CREATE INDEX collections_unsettled_due ON app.collections(client_id,due_date,id) WHERE cancelled_at IS NULL AND paid_minor<amount_minor;
CREATE TABLE app.payments (
 id uuid PRIMARY KEY CHECK(id<>'00000000-0000-0000-0000-000000000000'),
 collection_id uuid NOT NULL,
 client_id uuid NOT NULL,
 currency text NOT NULL,
 recorded_by uuid NOT NULL REFERENCES app.users(id),
 amount_minor bigint NOT NULL CHECK(amount_minor>0),
 paid_on date NOT NULL CHECK(paid_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 method text NOT NULL CHECK(method IN ('bank_transfer','cash','card','other')),
 reference text NOT NULL DEFAULT '' CHECK(char_length(reference)<=200 AND reference!~'[[:cntrl:]]'),
 note text NOT NULL DEFAULT '' CHECK(char_length(note)<=2000 AND replace(note,E'\n','')!~'[[:cntrl:]]'),
 command_id uuid NOT NULL CHECK(command_id<>'00000000-0000-0000-0000-000000000000'),
 expected_revision bigint NOT NULL CHECK(expected_revision>0 AND expected_revision<9223372036854775807),
 collection_revision bigint NOT NULL CHECK(collection_revision=expected_revision+1),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(collection_id,client_id,currency) REFERENCES app.collections(id,client_id,currency),
 UNIQUE(collection_id,command_id),UNIQUE(collection_id,collection_revision)
);
CREATE INDEX payments_collection_id ON app.payments(collection_id,id);

-- +goose StatementBegin
CREATE FUNCTION app.billing_history_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_TABLE_NAME='collections' AND TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.client_id,NEW.created_by,NEW.currency,NEW.currency_exponent,NEW.created_at) IS DISTINCT FROM
     (OLD.id,OLD.client_id,OLD.created_by,OLD.currency,OLD.currency_exponent,OLD.created_at) OR
    (OLD.cancelled_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) OR
    (NEW.amount_minor<>OLD.amount_minor AND EXISTS(SELECT 1 FROM app.payments WHERE collection_id=OLD.id)) THEN
   RAISE EXCEPTION 'Financial history is immutable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'Financial history cannot be removed or rewritten' USING ERRCODE='42501';
END; $$;
-- +goose StatementEnd
CREATE TRIGGER collection_history_guard BEFORE UPDATE OR DELETE ON app.collections FOR EACH ROW EXECUTE FUNCTION app.billing_history_guard();
CREATE TRIGGER collection_truncate_guard BEFORE TRUNCATE ON app.collections FOR EACH STATEMENT EXECUTE FUNCTION app.billing_history_guard();
CREATE TRIGGER payment_history_guard BEFORE UPDATE OR DELETE OR TRUNCATE ON app.payments FOR EACH STATEMENT EXECUTE FUNCTION app.billing_history_guard();
ALTER TABLE app.collections ENABLE ALWAYS TRIGGER collection_history_guard;
ALTER TABLE app.collections ENABLE ALWAYS TRIGGER collection_truncate_guard;
ALTER TABLE app.payments ENABLE ALWAYS TRIGGER payment_history_guard;
-- Cached balance must exactly equal the append-only ledger at commit.
-- Definer authority is required after the guarded writer has returned;
-- the committing runtime deliberately has no financial table privileges.
-- +goose StatementBegin
CREATE FUNCTION app.billing_balance_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE target uuid; balance numeric; collected bigint;
BEGIN
 IF TG_TABLE_NAME='payments' THEN target:=NEW.collection_id; ELSE target:=NEW.id; END IF;
 SELECT paid_minor INTO collected FROM app.collections WHERE id=target FOR UPDATE;
 SELECT coalesce(sum(amount_minor::numeric),0) INTO balance FROM app.payments WHERE collection_id=target;
 IF collected IS DISTINCT FROM balance THEN RAISE EXCEPTION 'Financial balance disagrees with ledger' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
-- +goose StatementEnd
CREATE CONSTRAINT TRIGGER collection_balance_guard AFTER INSERT OR UPDATE ON app.collections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.billing_balance_guard();
CREATE CONSTRAINT TRIGGER payment_balance_guard AFTER INSERT ON app.payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.billing_balance_guard();
ALTER TABLE app.collections ENABLE ALWAYS TRIGGER collection_balance_guard;
ALTER TABLE app.payments ENABLE ALWAYS TRIGGER payment_balance_guard;
-- +goose StatementBegin
CREATE FUNCTION app.billing_payment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.paid_on>(statement_timestamp() AT TIME ZONE 'UTC')::date OR EXISTS(SELECT 1 FROM app.collections WHERE id=NEW.collection_id AND cancelled_at IS NOT NULL) THEN
  RAISE EXCEPTION 'Invalid payment lifecycle' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd
CREATE TRIGGER payment_insert_guard BEFORE INSERT ON app.payments FOR EACH ROW EXECUTE FUNCTION app.billing_payment_guard();
ALTER TABLE app.payments ENABLE ALWAYS TRIGGER payment_insert_guard;

-- +goose StatementBegin
CREATE FUNCTION app.billing_status(total bigint,collected bigint,due date,cancelled timestamptz) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN cancelled IS NOT NULL THEN 'cancelled' WHEN collected=total THEN 'paid'
 WHEN due<(statement_timestamp() AT TIME ZONE 'UTC')::date THEN 'overdue'
 WHEN collected>0 THEN 'partially_paid' ELSE 'pending' END;
$$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.billing_document(target uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',c.id,'client_id',c.client_id,'created_by',c.created_by,'description',c.description,
 'internal_note',c.internal_note,'amount_minor',c.amount_minor::text,'paid_minor',c.paid_minor::text,
 'outstanding_minor',CASE WHEN c.cancelled_at IS NOT NULL THEN '0' ELSE (c.amount_minor-c.paid_minor)::text END,
 'currency',c.currency,'currency_exponent',c.currency_exponent,'due_date',to_char(c.due_date,'YYYY-MM-DD'),
 'status',app.billing_status(c.amount_minor,c.paid_minor,c.due_date,c.cancelled_at),'cancelled_at',c.cancelled_at,
 'revision',c.revision::text,'created_at',c.created_at,'updated_at',c.updated_at) FROM app.collections c WHERE c.id=target;
$$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.billing_snapshot(target uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('exists',true,'revision',c.revision,'billing_status',app.billing_status(c.amount_minor,c.paid_minor,c.due_date,c.cancelled_at),
 'currency',c.currency,'amount_minor',c.amount_minor::text,'paid_minor',c.paid_minor::text) FROM app.collections c WHERE c.id=target;
$$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.billing_read(actor uuid,client uuid,target uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT app.authorization_allowed(actor,'billing.view',client) OR NOT EXISTS(SELECT 1 FROM app.collections WHERE id=target AND client_id=client) THEN RETURN NULL; END IF;
 RETURN app.billing_document(target);
END; $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.billing_list(actor uuid,client uuid,after_id uuid,page_limit integer,state text,requested_currency text,search text) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT app.authorization_allowed(actor,'billing.view',client) OR NOT EXISTS(SELECT 1 FROM app.clients WHERE id=client) THEN RAISE no_data_found; END IF;
 IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 101 OR state IS NULL OR state NOT IN ('all','pending','partially_paid','paid','overdue','cancelled') OR
 requested_currency IS NULL OR (requested_currency<>'' AND NOT EXISTS(SELECT 1 FROM app.billing_currencies WHERE code=requested_currency)) OR
 search IS NULL OR char_length(search)>100 OR search~'[[:cntrl:]]' THEN RAISE invalid_parameter_value; END IF;
 RETURN QUERY SELECT app.billing_document(c.id) FROM app.collections c WHERE c.client_id=client AND
 (after_id IS NULL OR c.id>after_id) AND (state='all' OR app.billing_status(c.amount_minor,c.paid_minor,c.due_date,c.cancelled_at)=state) AND
 (requested_currency='' OR c.currency=requested_currency) AND (search='' OR strpos(lower(c.description),lower(search))>0) ORDER BY c.id LIMIT page_limit;
END; $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.billing_payments(actor uuid,client uuid,target uuid,after_id uuid,page_limit integer) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT app.authorization_allowed(actor,'billing.view',client) OR NOT EXISTS(SELECT 1 FROM app.collections WHERE id=target AND client_id=client) THEN RAISE no_data_found; END IF;
 IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 101 THEN RAISE invalid_parameter_value; END IF;
 RETURN QUERY SELECT jsonb_build_object('id',p.id,'collection_id',p.collection_id,'client_id',p.client_id,'recorded_by',p.recorded_by,
 'amount_minor',p.amount_minor::text,'currency',p.currency,'paid_on',to_char(p.paid_on,'YYYY-MM-DD'),'method',p.method,
 'reference',p.reference,'note',p.note,'command_id',p.command_id,'collection_revision',p.collection_revision::text,'recorded_at',p.recorded_at)
 FROM app.payments p WHERE p.collection_id=target AND (after_id IS NULL OR p.id>after_id) ORDER BY p.id LIMIT page_limit;
END; $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.billing_summary(actor uuid,client uuid) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT app.authorization_allowed(actor,'billing.view',client) OR NOT EXISTS(SELECT 1 FROM app.clients WHERE id=client) THEN RAISE no_data_found; END IF;
 RETURN QUERY SELECT jsonb_build_object('currency',c.currency,'currency_exponent',c.currency_exponent,
 'amount_minor',coalesce(sum(c.amount_minor::numeric) FILTER(WHERE c.cancelled_at IS NULL),0)::text,
 'paid_minor',coalesce(sum(c.paid_minor::numeric) FILTER(WHERE c.cancelled_at IS NULL),0)::text,
 'outstanding_minor',coalesce(sum((c.amount_minor-c.paid_minor)::numeric) FILTER(WHERE c.cancelled_at IS NULL),0)::text,
 'overdue_minor',coalesce(sum((c.amount_minor-c.paid_minor)::numeric) FILTER(WHERE c.cancelled_at IS NULL AND c.due_date<(statement_timestamp() AT TIME ZONE 'UTC')::date),0)::text,
 'cancelled_amount_minor',coalesce(sum(c.amount_minor::numeric) FILTER(WHERE c.cancelled_at IS NOT NULL),0)::text,
 'cancelled_paid_minor',coalesce(sum(c.paid_minor::numeric) FILTER(WHERE c.cancelled_at IS NOT NULL),0)::text)
 FROM app.collections c WHERE c.client_id=client GROUP BY c.currency,c.currency_exponent ORDER BY c.currency;
END; $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.billing_currency_list(actor uuid,client uuid) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT app.authorization_allowed(actor,'billing.view',client) OR NOT EXISTS(SELECT 1 FROM app.clients WHERE id=client) THEN RAISE no_data_found; END IF;
 RETURN QUERY SELECT jsonb_build_object('code',code,'exponent',exponent) FROM app.billing_currencies ORDER BY code;
END; $$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION app.billing_write(actor uuid,client uuid,target uuid,expected bigint,operation text,profile jsonb,new_payment uuid)
RETURNS TABLE(code text,before_state jsonb,after_state jsonb,payment_id uuid,new_revision bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous app.collections%ROWTYPE; prior_payment app.payments%ROWTYPE; before_value jsonb:='null'::jsonb;
 stamp timestamptz; amount bigint; unit smallint; due date; payment_day date; command uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(871092650209);
 IF operation IS NULL OR operation NOT IN ('create','update','payment','cancel') OR target IS NULL OR target='00000000-0000-0000-0000-000000000000' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::jsonb,NULL::jsonb,NULL::uuid,0::bigint;RETURN; END IF;
 IF NOT app.authorization_allowed(actor,'billing.view',client) OR NOT app.authorization_allowed(actor,CASE operation WHEN 'create' THEN 'billing.create' WHEN 'cancel' THEN 'billing.delete' ELSE 'billing.update' END,client) OR
 NOT EXISTS(SELECT 1 FROM app.clients WHERE id=client) THEN RETURN QUERY SELECT 'missing'::text,NULL::jsonb,NULL::jsonb,NULL::uuid,0::bigint;RETURN; END IF;
 IF operation<>'create' THEN
  SELECT * INTO previous FROM app.collections WHERE id=target AND client_id=client FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'missing'::text,NULL::jsonb,NULL::jsonb,NULL::uuid,0::bigint;RETURN; END IF;
  before_value:=app.billing_snapshot(target);
 END IF;
 IF operation IN ('create','update','payment') THEN
  IF profile IS NULL OR jsonb_typeof(profile)<>'object' OR jsonb_typeof(profile->'amount_minor') IS DISTINCT FROM 'string' OR
   profile->>'amount_minor' !~ '^[1-9][0-9]{0,18}$' OR (profile->>'amount_minor')::numeric>9223372036854775807 OR
   jsonb_typeof(profile->'currency') IS DISTINCT FROM 'string' THEN RETURN QUERY SELECT 'invalid'::text,NULL::jsonb,NULL::jsonb,NULL::uuid,0::bigint;RETURN; END IF;
  amount:=(profile->>'amount_minor')::bigint;
  SELECT bc.exponent INTO unit FROM app.billing_currencies bc WHERE bc.code=profile->>'currency';
  IF NOT FOUND THEN RETURN QUERY SELECT 'invalid'::text,NULL::jsonb,NULL::jsonb,NULL::uuid,0::bigint;RETURN; END IF;
 END IF;
 IF operation='payment' THEN
  IF profile-ARRAY['command_id','amount_minor','currency','paid_on','method','reference','note']<>'{}'::jsonb OR
   jsonb_typeof(profile->'command_id') IS DISTINCT FROM 'string' OR jsonb_typeof(profile->'paid_on') IS DISTINCT FROM 'string' OR
   jsonb_typeof(profile->'method') IS DISTINCT FROM 'string' OR profile->>'method' NOT IN ('bank_transfer','cash','card','other') OR
   jsonb_typeof(profile->'reference') IS DISTINCT FROM 'string' OR char_length(profile->>'reference')>200 OR profile->>'reference'~'[[:cntrl:]]' OR
   jsonb_typeof(profile->'note') IS DISTINCT FROM 'string' OR char_length(profile->>'note')>2000 OR replace(profile->>'note',E'\n','')~'[[:cntrl:]]' OR
   profile->>'paid_on' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN QUERY SELECT 'invalid'::text,NULL::jsonb,NULL::jsonb,NULL::uuid,0::bigint;RETURN; END IF;
  command:=(profile->>'command_id')::uuid;payment_day:=(profile->>'paid_on')::date;
  IF command='00000000-0000-0000-0000-000000000000' OR payment_day NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' OR
   to_char(payment_day,'YYYY-MM-DD')<>profile->>'paid_on' OR payment_day>(statement_timestamp() AT TIME ZONE 'UTC')::date THEN RETURN QUERY SELECT 'invalid'::text,NULL::jsonb,NULL::jsonb,NULL::uuid,0::bigint;RETURN; END IF;
  SELECT * INTO prior_payment FROM app.payments WHERE collection_id=target AND command_id=command;
  IF FOUND THEN
   IF (prior_payment.recorded_by,prior_payment.expected_revision,prior_payment.amount_minor,prior_payment.currency,prior_payment.paid_on,prior_payment.method,prior_payment.reference,prior_payment.note) IS DISTINCT FROM
      (actor,expected,amount,profile->>'currency',payment_day,profile->>'method',profile->>'reference',profile->>'note') THEN RETURN QUERY SELECT 'conflict'::text,NULL::jsonb,NULL::jsonb,NULL::uuid,0::bigint;RETURN; END IF;
   RETURN QUERY SELECT 'replay'::text,NULL::jsonb,NULL::jsonb,prior_payment.id,previous.revision;RETURN;
  END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM app.clients WHERE id=client AND archived_at IS NOT NULL) OR
 (operation='create' AND expected IS DISTINCT FROM 0::bigint) OR
 (operation<>'create' AND (expected IS NULL OR expected<1 OR expected=9223372036854775807 OR expected<>previous.revision OR previous.cancelled_at IS NOT NULL)) THEN RETURN QUERY SELECT 'conflict'::text,NULL::jsonb,NULL::jsonb,NULL::uuid,0::bigint;RETURN; END IF;
 stamp:=clock_timestamp();
 IF operation='cancel' THEN
  IF previous.paid_minor=previous.amount_minor THEN RETURN QUERY SELECT 'conflict'::text,NULL::jsonb,NULL::jsonb,NULL::uuid,0::bigint;RETURN; END IF;
  UPDATE app.collections SET cancelled_at=stamp,revision=revision+1,updated_at=stamp WHERE id=target;
 ELSIF operation='payment' THEN
  IF profile->>'currency'<>previous.currency OR amount>previous.amount_minor-previous.paid_minor OR new_payment IS NULL OR new_payment='00000000-0000-0000-0000-000000000000' THEN RETURN QUERY SELECT 'conflict'::text,NULL::jsonb,NULL::jsonb,NULL::uuid,0::bigint;RETURN; END IF;
  INSERT INTO app.payments(id,collection_id,client_id,currency,recorded_by,amount_minor,paid_on,method,reference,note,command_id,expected_revision,collection_revision,recorded_at)
  VALUES(new_payment,target,client,previous.currency,actor,amount,payment_day,profile->>'method',profile->>'reference',profile->>'note',command,expected,expected+1,stamp);
  UPDATE app.collections SET paid_minor=paid_minor+amount,revision=revision+1,updated_at=stamp WHERE id=target;
 ELSE
  IF profile-ARRAY['description','internal_note','amount_minor','currency','due_date']<>'{}'::jsonb OR
   jsonb_typeof(profile->'description') IS DISTINCT FROM 'string' OR char_length(profile->>'description') NOT BETWEEN 1 AND 2000 OR profile->>'description'<>btrim(profile->>'description') OR replace(profile->>'description',E'\n','')~'[[:cntrl:]]' OR
   jsonb_typeof(profile->'internal_note') IS DISTINCT FROM 'string' OR char_length(profile->>'internal_note')>8000 OR replace(profile->>'internal_note',E'\n','')~'[[:cntrl:]]' OR
   NOT coalesce(jsonb_typeof(profile->'due_date') IN ('null','string'),false) THEN RETURN QUERY SELECT 'invalid'::text,NULL::jsonb,NULL::jsonb,NULL::uuid,0::bigint;RETURN; END IF;
  IF profile->>'due_date' IS NOT NULL THEN
   IF profile->>'due_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN QUERY SELECT 'invalid'::text,NULL::jsonb,NULL::jsonb,NULL::uuid,0::bigint;RETURN; END IF;
   due:=(profile->>'due_date')::date;
   IF due NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' OR to_char(due,'YYYY-MM-DD')<>profile->>'due_date' THEN RETURN QUERY SELECT 'invalid'::text,NULL::jsonb,NULL::jsonb,NULL::uuid,0::bigint;RETURN; END IF;
  END IF;
  IF operation='create' THEN
   INSERT INTO app.collections(id,client_id,created_by,description,internal_note,amount_minor,currency,currency_exponent,due_date,created_at,updated_at)
   VALUES(target,client,actor,profile->>'description',profile->>'internal_note',amount,profile->>'currency',unit,due,stamp,stamp);
  ELSE
   IF profile->>'currency'<>previous.currency OR (amount<>previous.amount_minor AND previous.paid_minor>0) THEN RETURN QUERY SELECT 'conflict'::text,NULL::jsonb,NULL::jsonb,NULL::uuid,0::bigint;RETURN; END IF;
   UPDATE app.collections SET description=profile->>'description',internal_note=profile->>'internal_note',amount_minor=amount,due_date=due,revision=revision+1,updated_at=stamp WHERE id=target;
  END IF;
 END IF;
 RETURN QUERY SELECT 'ok'::text,before_value,app.billing_snapshot(target),CASE WHEN operation='payment' THEN new_payment END,
  CASE WHEN operation='create' THEN 1::bigint ELSE expected+1 END;
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range OR check_violation THEN
 RETURN QUERY SELECT 'invalid'::text,NULL::jsonb,NULL::jsonb,NULL::uuid,0::bigint;
END; $$;
-- +goose StatementEnd
REVOKE ALL ON app.billing_currencies,app.collections,app.payments FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.billing_history_guard(),app.billing_balance_guard(),app.billing_payment_guard(),
 app.billing_status(bigint,bigint,date,timestamptz),app.billing_document(uuid),app.billing_snapshot(uuid),
 app.billing_read(uuid,uuid,uuid),app.billing_list(uuid,uuid,uuid,integer,text,text,text),
 app.billing_payments(uuid,uuid,uuid,uuid,integer),app.billing_summary(uuid,uuid),app.billing_currency_list(uuid,uuid),
 app.billing_write(uuid,uuid,uuid,bigint,text,jsonb,uuid) FROM PUBLIC;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.audit_snapshot_allowed(value jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE STRICT SET search_path=pg_catalog AS $$
DECLARE scheduled timestamptz;
BEGIN
 IF value='null'::jsonb THEN RETURN true; END IF;
 IF value ?| ARRAY['billing_status','currency','amount_minor','paid_minor'] THEN
  IF NOT value ?& ARRAY['billing_status','currency','amount_minor','paid_minor'] OR
   jsonb_typeof(value->'billing_status') IS DISTINCT FROM 'string' OR value->>'billing_status' NOT IN ('pending','partially_paid','paid','overdue','cancelled') OR
   jsonb_typeof(value->'currency') IS DISTINCT FROM 'string' OR value->>'currency' NOT IN ('USD','EUR','GBP','TRY','JPY','KWD') OR
   jsonb_typeof(value->'amount_minor') IS DISTINCT FROM 'string' OR value->>'amount_minor' !~ '^[1-9][0-9]{0,18}$' OR
   jsonb_typeof(value->'paid_minor') IS DISTINCT FROM 'string' OR value->>'paid_minor' !~ '^(0|[1-9][0-9]{0,18})$' THEN RETURN false; END IF;
  IF (value->>'amount_minor')::numeric>9223372036854775807 OR (value->>'paid_minor')::numeric>(value->>'amount_minor')::numeric THEN RETURN false; END IF;
 END IF;
 value:=value-ARRAY['billing_status','currency','amount_minor','paid_minor'];

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
ALTER TABLE app.audit_events DROP CONSTRAINT audit_event_action;
ALTER TABLE app.audit_events ADD CONSTRAINT audit_event_action CHECK (
 (resource_kind NOT IN ('reminder','billing') AND (event_name IN (resource_kind||'.created',resource_kind||'.updated',resource_kind||'.archived',resource_kind||'.deleted') OR
 (resource_kind='user' AND event_name='user.disabled') OR (resource_kind='role' AND event_name='role.permission_changed') OR
 (resource_kind='task' AND event_name IN ('task.completed','task.cancelled')))) OR
 (resource_kind='reminder' AND event_name IN ('reminder.created','reminder.updated','reminder.completed','reminder.dismissed')) OR
 (resource_kind='billing' AND event_name IN ('billing.created','billing.updated','billing.payment_recorded','billing.cancelled')));
ALTER TABLE app.audit_events ADD CONSTRAINT audit_billing_snapshot_kind CHECK (
 NOT (before_state ?| ARRAY['billing_status','currency','amount_minor','paid_minor'] OR after_state ?| ARRAY['billing_status','currency','amount_minor','paid_minor']) OR resource_kind='billing');
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.audit_reader_list(actor uuid,scope_client uuid,filter_client uuid,filter_actor uuid,
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
 (filter_event IS NOT NULL AND filter_event !~ '^[a-z][a-z0-9_]{0,31}\.(created|updated|archived|deleted|disabled|permission_changed|completed|cancelled|dismissed|payment_recorded)$') OR
 (filter_event LIKE '%.payment_recorded' AND filter_event<>'billing.payment_recorded') OR
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

-- +goose Down
SELECT pg_advisory_xact_lock(871092650209);
LOCK TABLE app.collections,app.payments,app.permissions,app.role_permissions,app.audit_events IN ACCESS EXCLUSIVE MODE;
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM app.collections) OR EXISTS(SELECT 1 FROM app.payments) OR EXISTS(SELECT 1 FROM app.audit_events WHERE resource_kind='billing') OR
 EXISTS(SELECT 1 FROM app.role_permissions WHERE permission_key IN ('billing.create','billing.update','billing.delete') AND
 (NOT seeded OR revoked_at IS NOT NULL OR role_id<>'00000000-0000-4000-8000-000000000001'::uuid)) THEN RAISE EXCEPTION 'Rollback refused: financial or permission history is not empty'; END IF;
END; $$;
-- +goose StatementEnd
DROP FUNCTION app.billing_read(uuid,uuid,uuid),app.billing_list(uuid,uuid,uuid,integer,text,text,text),app.billing_payments(uuid,uuid,uuid,uuid,integer),app.billing_summary(uuid,uuid),app.billing_currency_list(uuid,uuid),app.billing_write(uuid,uuid,uuid,bigint,text,jsonb,uuid);
DROP FUNCTION app.billing_document(uuid),app.billing_snapshot(uuid),app.billing_status(bigint,bigint,date,timestamptz);
DROP TABLE app.payments,app.collections,app.billing_currencies;
DROP FUNCTION app.billing_history_guard(),app.billing_balance_guard(),app.billing_payment_guard();
DELETE FROM app.role_permissions WHERE permission_key IN ('billing.create','billing.update','billing.delete');
DELETE FROM app.permissions WHERE permission_key IN ('billing.create','billing.update','billing.delete');
ALTER TABLE app.audit_events DROP CONSTRAINT audit_billing_snapshot_kind;
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
ALTER TABLE app.audit_events DROP CONSTRAINT audit_event_action;
ALTER TABLE app.audit_events ADD CONSTRAINT audit_event_action CHECK (
 (resource_kind<>'reminder' AND (event_name IN (resource_kind||'.created',resource_kind||'.updated',resource_kind||'.archived',resource_kind||'.deleted') OR
 (resource_kind='user' AND event_name='user.disabled') OR (resource_kind='role' AND event_name='role.permission_changed') OR
 (resource_kind='task' AND event_name IN ('task.completed','task.cancelled')))) OR
 (resource_kind='reminder' AND event_name IN ('reminder.created','reminder.updated','reminder.completed','reminder.dismissed')));
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.audit_reader_list(actor uuid,scope_client uuid,filter_client uuid,filter_actor uuid,
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
