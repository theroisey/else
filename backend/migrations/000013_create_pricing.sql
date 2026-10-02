-- +goose Up
CREATE TABLE app.pricing_sheets (
 id uuid PRIMARY KEY CHECK(id<>'00000000-0000-0000-0000-000000000000'),
 client_id uuid NOT NULL REFERENCES app.clients(id), currency text NOT NULL, currency_exponent smallint NOT NULL,
 revision bigint NOT NULL CHECK(revision>0),
 FOREIGN KEY(currency,currency_exponent) REFERENCES app.billing_currencies(code,exponent),
 UNIQUE(id,client_id,currency)
);
CREATE INDEX pricing_sheets_client ON app.pricing_sheets(client_id,id);
CREATE TABLE app.pricing_versions (
 id uuid PRIMARY KEY CHECK(id<>'00000000-0000-0000-0000-000000000000'),
 sheet_id uuid NOT NULL, client_id uuid NOT NULL, currency text NOT NULL,
 revision bigint NOT NULL CHECK(revision>0),
 title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 200 AND title=btrim(title) AND title!~'[[:cntrl:]]'),
 note text NOT NULL CHECK(char_length(note)<=2000 AND replace(note,E'\n','')!~'[[:cntrl:]]'),
 effective_from date NOT NULL CHECK(effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 effective_until date CHECK(effective_until>effective_from AND effective_until<=DATE '9999-12-31'),
 created_by uuid NOT NULL REFERENCES app.users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 base_minor bigint NOT NULL CHECK(base_minor>=0), discount_minor bigint NOT NULL CHECK(discount_minor>=0 AND discount_minor<=base_minor),
 net_minor bigint NOT NULL CHECK(net_minor=base_minor-discount_minor), tax_minor bigint NOT NULL CHECK(tax_minor>=0),
 total_minor bigint NOT NULL CHECK(total_minor::numeric=net_minor::numeric+tax_minor), cost_minor bigint CHECK(cost_minor>=0),
 creation_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 FOREIGN KEY(sheet_id,client_id,currency) REFERENCES app.pricing_sheets(id,client_id,currency),
 UNIQUE(sheet_id,revision), UNIQUE(id,sheet_id,client_id,currency)
);
CREATE INDEX pricing_versions_sheet_id ON app.pricing_versions(sheet_id,id);
CREATE TABLE app.pricing_lines (
 version_id uuid NOT NULL REFERENCES app.pricing_versions(id), position integer NOT NULL CHECK(position BETWEEN 1 AND 50),
 description text NOT NULL CHECK(char_length(description) BETWEEN 1 AND 200 AND description=btrim(description) AND description!~'[[:cntrl:]]'),
 kind text NOT NULL CHECK(kind IN ('recurring','one_time','custom')),
 frequency text NOT NULL CHECK(frequency IN ('none','weekly','monthly','quarterly','yearly')),
 quantity_micros bigint NOT NULL CHECK(quantity_micros>0), unit_price_minor bigint NOT NULL CHECK(unit_price_minor>=0),
 discount_bps integer NOT NULL CHECK(discount_bps BETWEEN 0 AND 10000), tax_bps integer NOT NULL CHECK(tax_bps BETWEEN 0 AND 10000),
 unit_cost_minor bigint CHECK(unit_cost_minor>=0),
 base_minor bigint NOT NULL CHECK(base_minor::numeric=round(quantity_micros::numeric*unit_price_minor/1000000)),
 discount_minor bigint NOT NULL CHECK(discount_minor::numeric=round(base_minor::numeric*discount_bps/10000)),
 net_minor bigint NOT NULL CHECK(net_minor=base_minor-discount_minor),
 tax_minor bigint NOT NULL CHECK(tax_minor::numeric=round(net_minor::numeric*tax_bps/10000)),
 total_minor bigint NOT NULL CHECK(total_minor::numeric=net_minor::numeric+tax_minor),
 cost_minor bigint CHECK(cost_minor::numeric IS NOT DISTINCT FROM round(quantity_micros::numeric*unit_cost_minor/1000000)),
 CHECK((kind<>'recurring' OR frequency<>'none') AND (kind<>'one_time' OR frequency='none')),
 PRIMARY KEY(version_id,position)
);
CREATE TABLE app.pricing_snapshots (
 collection_id uuid PRIMARY KEY, client_id uuid NOT NULL, sheet_id uuid NOT NULL, version_id uuid NOT NULL, currency text NOT NULL,
 command_id uuid NOT NULL CHECK(command_id<>'00000000-0000-0000-0000-000000000000'),
 expected_revision bigint NOT NULL CHECK(expected_revision>0),
 created_by uuid NOT NULL REFERENCES app.users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 billing_date date NOT NULL CHECK(billing_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 original_due_date date CHECK(original_due_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 original_internal_note text NOT NULL CHECK(char_length(original_internal_note)<=8000 AND replace(original_internal_note,E'\n','')!~'[[:cntrl:]]'),
 title text NOT NULL, base_minor bigint NOT NULL, discount_minor bigint NOT NULL, net_minor bigint NOT NULL, tax_minor bigint NOT NULL, total_minor bigint NOT NULL CHECK(total_minor>0),
 creation_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 FOREIGN KEY(collection_id,client_id,currency) REFERENCES app.collections(id,client_id,currency),
 FOREIGN KEY(version_id,sheet_id,client_id,currency) REFERENCES app.pricing_versions(id,sheet_id,client_id,currency),
 UNIQUE(client_id,command_id)
);
-- Copies deliberately contain no internal costs or pricing notes.
CREATE TABLE app.pricing_snapshot_lines (
 collection_id uuid NOT NULL REFERENCES app.pricing_snapshots(collection_id), position integer NOT NULL CHECK(position BETWEEN 1 AND 50),
 description text NOT NULL, kind text NOT NULL, frequency text NOT NULL,
 quantity_micros bigint NOT NULL, unit_price_minor bigint NOT NULL, discount_bps integer NOT NULL, tax_bps integer NOT NULL,
 base_minor bigint NOT NULL, discount_minor bigint NOT NULL, net_minor bigint NOT NULL, tax_minor bigint NOT NULL, total_minor bigint NOT NULL,
 PRIMARY KEY(collection_id,position)
);

-- +goose StatementBegin
CREATE FUNCTION app.pricing_history_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_TABLE_NAME='pricing_sheets' AND TG_OP='UPDATE' AND
  (NEW.id,NEW.client_id,NEW.currency,NEW.currency_exponent) IS NOT DISTINCT FROM (OLD.id,OLD.client_id,OLD.currency,OLD.currency_exponent) AND NEW.revision::numeric=OLD.revision::numeric+1 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Pricing history is immutable' USING ERRCODE='42501';
END; $$;
-- +goose StatementEnd
CREATE TRIGGER pricing_sheet_guard BEFORE UPDATE ON app.pricing_sheets FOR EACH ROW EXECUTE FUNCTION app.pricing_history_guard();
CREATE TRIGGER pricing_sheet_removal_guard BEFORE DELETE OR TRUNCATE ON app.pricing_sheets FOR EACH STATEMENT EXECUTE FUNCTION app.pricing_history_guard();
CREATE TRIGGER pricing_version_guard BEFORE UPDATE OR DELETE OR TRUNCATE ON app.pricing_versions FOR EACH STATEMENT EXECUTE FUNCTION app.pricing_history_guard();
CREATE TRIGGER pricing_line_guard BEFORE UPDATE OR DELETE OR TRUNCATE ON app.pricing_lines FOR EACH STATEMENT EXECUTE FUNCTION app.pricing_history_guard();
CREATE TRIGGER pricing_snapshot_guard BEFORE UPDATE OR DELETE OR TRUNCATE ON app.pricing_snapshots FOR EACH STATEMENT EXECUTE FUNCTION app.pricing_history_guard();
CREATE TRIGGER pricing_snapshot_line_guard BEFORE UPDATE OR DELETE OR TRUNCATE ON app.pricing_snapshot_lines FOR EACH STATEMENT EXECUTE FUNCTION app.pricing_history_guard();
ALTER TABLE app.pricing_sheets ENABLE ALWAYS TRIGGER pricing_sheet_guard;
ALTER TABLE app.pricing_sheets ENABLE ALWAYS TRIGGER pricing_sheet_removal_guard;
ALTER TABLE app.pricing_versions ENABLE ALWAYS TRIGGER pricing_version_guard;
ALTER TABLE app.pricing_lines ENABLE ALWAYS TRIGGER pricing_line_guard;
ALTER TABLE app.pricing_snapshots ENABLE ALWAYS TRIGGER pricing_snapshot_guard;
ALTER TABLE app.pricing_snapshot_lines ENABLE ALWAYS TRIGGER pricing_snapshot_line_guard;

-- A zero-valued later line would leave aggregate totals unchanged. Bind all
-- lines to their header's creation transaction as well as checking exact sums.
-- +goose StatementBegin
CREATE FUNCTION app.pricing_insert_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE original_xid xid8; previous_day date; latest bigint;
BEGIN
 IF TG_TABLE_NAME='pricing_versions' THEN
  SELECT revision INTO latest FROM app.pricing_sheets WHERE id=NEW.sheet_id FOR UPDATE;
  SELECT effective_from INTO previous_day FROM app.pricing_versions WHERE sheet_id=NEW.sheet_id AND revision=NEW.revision-1;
  IF NEW.revision IS DISTINCT FROM latest OR (NEW.revision>1 AND (previous_day IS NULL OR NEW.effective_from<previous_day OR NEW.effective_from<(statement_timestamp() AT TIME ZONE 'UTC')::date)) OR NEW.creation_xid<>pg_current_xact_id() THEN RAISE check_violation; END IF;
  RETURN NEW;
 ELSIF TG_TABLE_NAME='pricing_lines' THEN SELECT creation_xid INTO original_xid FROM app.pricing_versions WHERE id=NEW.version_id;
 ELSE SELECT creation_xid INTO original_xid FROM app.pricing_snapshots WHERE collection_id=NEW.collection_id; END IF;
 IF original_xid IS DISTINCT FROM pg_current_xact_id() THEN RAISE EXCEPTION 'Pricing lines are immutable after creation' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd
CREATE TRIGGER pricing_version_insert_guard BEFORE INSERT ON app.pricing_versions FOR EACH ROW EXECUTE FUNCTION app.pricing_insert_guard();
CREATE TRIGGER pricing_line_insert_guard BEFORE INSERT ON app.pricing_lines FOR EACH ROW EXECUTE FUNCTION app.pricing_insert_guard();
CREATE TRIGGER pricing_snapshot_line_insert_guard BEFORE INSERT ON app.pricing_snapshot_lines FOR EACH ROW EXECUTE FUNCTION app.pricing_insert_guard();
ALTER TABLE app.pricing_versions ENABLE ALWAYS TRIGGER pricing_version_insert_guard;
ALTER TABLE app.pricing_lines ENABLE ALWAYS TRIGGER pricing_line_insert_guard;
ALTER TABLE app.pricing_snapshot_lines ENABLE ALWAYS TRIGGER pricing_snapshot_line_insert_guard;

-- +goose StatementBegin
CREATE FUNCTION app.pricing_amount_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.amount_minor<>OLD.amount_minor AND EXISTS(SELECT 1 FROM app.pricing_snapshots WHERE collection_id=OLD.id) THEN
  RAISE EXCEPTION 'Copied collection amount is immutable' USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd
CREATE TRIGGER pricing_collection_amount_guard BEFORE UPDATE ON app.collections FOR EACH ROW EXECUTE FUNCTION app.pricing_amount_guard();
ALTER TABLE app.collections ENABLE ALWAYS TRIGGER pricing_collection_amount_guard;

-- +goose StatementBegin
CREATE FUNCTION app.pricing_consistency_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE target uuid; v app.pricing_versions%ROWTYPE; p app.pricing_snapshots%ROWTYPE; s app.pricing_sheets%ROWTYPE; totals record;
BEGIN
 IF TG_TABLE_NAME IN ('pricing_sheets','pricing_versions','pricing_lines') THEN
  IF TG_TABLE_NAME='pricing_sheets' THEN SELECT * INTO v FROM app.pricing_versions WHERE sheet_id=NEW.id ORDER BY revision DESC LIMIT 1;
  ELSIF TG_TABLE_NAME='pricing_versions' THEN SELECT * INTO v FROM app.pricing_versions WHERE id=NEW.id;
  ELSE SELECT * INTO v FROM app.pricing_versions WHERE id=NEW.version_id; END IF;
  IF v.id IS NULL THEN RAISE check_violation; END IF;
  SELECT * INTO s FROM app.pricing_sheets WHERE id=v.sheet_id FOR UPDATE;
  IF s.revision<>(SELECT max(revision) FROM app.pricing_versions WHERE sheet_id=s.id) OR
   s.revision<>(SELECT count(*) FROM app.pricing_versions WHERE sheet_id=s.id) OR
   EXISTS(SELECT 1 FROM app.pricing_versions a JOIN app.pricing_versions b ON b.sheet_id=a.sheet_id AND b.revision=a.revision-1 WHERE a.sheet_id=s.id AND a.effective_from<b.effective_from) THEN RAISE check_violation; END IF;
  SELECT count(*) AS count,max(position) AS last,sum(base_minor::numeric) AS base,sum(discount_minor::numeric) AS discount,sum(net_minor::numeric) AS net,sum(tax_minor::numeric) AS tax,sum(total_minor::numeric) AS total,
   CASE WHEN count(cost_minor)=count(*) THEN sum(cost_minor::numeric) END AS cost,sum(cost_minor::numeric) AS known_cost INTO totals FROM app.pricing_lines WHERE version_id=v.id;
  IF totals.count NOT BETWEEN 1 AND 50 OR totals.last<>totals.count OR coalesce(totals.known_cost,0)>9223372036854775807 OR
   (v.base_minor::numeric,v.discount_minor::numeric,v.net_minor::numeric,v.tax_minor::numeric,v.total_minor::numeric,v.cost_minor::numeric) IS DISTINCT FROM (totals.base,totals.discount,totals.net,totals.tax,totals.total,totals.cost) THEN RAISE check_violation; END IF;
 ELSE
  target:=NEW.collection_id;
  SELECT * INTO p FROM app.pricing_snapshots WHERE collection_id=target;
  SELECT * INTO v FROM app.pricing_versions WHERE id=p.version_id;
  IF (p.title,p.base_minor,p.discount_minor,p.net_minor,p.tax_minor,p.total_minor) IS DISTINCT FROM (v.title,v.base_minor,v.discount_minor,v.net_minor,v.tax_minor,v.total_minor) OR
   p.billing_date>(statement_timestamp() AT TIME ZONE 'UTC')::date OR
   NOT EXISTS(SELECT 1 FROM app.collections WHERE id=target AND amount_minor=p.total_minor) OR
   (SELECT count(*) FROM app.pricing_snapshot_lines WHERE collection_id=target)<>(SELECT count(*) FROM app.pricing_lines WHERE version_id=v.id) OR
   EXISTS(SELECT 1 FROM app.pricing_snapshot_lines l LEFT JOIN app.pricing_lines original ON original.version_id=v.id AND original.position=l.position
    WHERE l.collection_id=target AND (l.position,l.description,l.kind,l.frequency,l.quantity_micros,l.unit_price_minor,l.discount_bps,l.tax_bps,l.base_minor,l.discount_minor,l.net_minor,l.tax_minor,l.total_minor) IS DISTINCT FROM
    (original.position,original.description,original.kind,original.frequency,original.quantity_micros,original.unit_price_minor,original.discount_bps,original.tax_bps,original.base_minor,original.discount_minor,original.net_minor,original.tax_minor,original.total_minor)) THEN RAISE check_violation; END IF;
 END IF;
 RETURN NULL;
END; $$;
-- +goose StatementEnd
CREATE CONSTRAINT TRIGGER pricing_sheet_consistency AFTER INSERT OR UPDATE ON app.pricing_sheets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.pricing_consistency_guard();
CREATE CONSTRAINT TRIGGER pricing_version_consistency AFTER INSERT ON app.pricing_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.pricing_consistency_guard();
CREATE CONSTRAINT TRIGGER pricing_line_consistency AFTER INSERT ON app.pricing_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.pricing_consistency_guard();
CREATE CONSTRAINT TRIGGER pricing_snapshot_consistency AFTER INSERT ON app.pricing_snapshots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.pricing_consistency_guard();
CREATE CONSTRAINT TRIGGER pricing_snapshot_line_consistency AFTER INSERT ON app.pricing_snapshot_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.pricing_consistency_guard();
ALTER TABLE app.pricing_sheets ENABLE ALWAYS TRIGGER pricing_sheet_consistency;
ALTER TABLE app.pricing_versions ENABLE ALWAYS TRIGGER pricing_version_consistency;
ALTER TABLE app.pricing_lines ENABLE ALWAYS TRIGGER pricing_line_consistency;
ALTER TABLE app.pricing_snapshots ENABLE ALWAYS TRIGGER pricing_snapshot_consistency;
ALTER TABLE app.pricing_snapshot_lines ENABLE ALWAYS TRIGGER pricing_snapshot_line_consistency;

-- Canonical string parsing precedes every numeric/date cast. No floating point.
-- +goose StatementBegin
CREATE FUNCTION app.pricing_integer(value jsonb,positive boolean,maximum numeric DEFAULT 9223372036854775807) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE result numeric;
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'string' OR value#>>'{}' !~ '^(0|[1-9][0-9]{0,18})$' THEN RAISE invalid_parameter_value; END IF;
 result:=(value#>>'{}')::numeric;
 IF result>maximum OR (positive AND result=0) THEN RAISE invalid_parameter_value; END IF;
 RETURN result::bigint;
END; $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.pricing_date(value jsonb,optional boolean) RETURNS date
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE result date;
BEGIN
 IF optional AND (value IS NULL OR value='null'::jsonb) THEN RETURN NULL; END IF;
 IF jsonb_typeof(value) IS DISTINCT FROM 'string' OR value#>>'{}' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE invalid_parameter_value; END IF;
 result:=(value#>>'{}')::date;
 IF result NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' OR to_char(result,'YYYY-MM-DD')<>value#>>'{}' THEN RAISE invalid_parameter_value; END IF;
 RETURN result;
END; $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.pricing_calculate(profile jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE l jsonb; lines jsonb:='[]'::jsonb; exponent smallint; q bigint; u bigint; d bigint; t bigint; c bigint;
 b numeric; discount numeric; net numeric; tax numeric; total numeric; cost numeric;
 sb numeric:=0; sd numeric:=0; sn numeric:=0; st numeric:=0; sa numeric:=0; sc numeric:=0; known boolean:=true; start_day date; end_day date;
BEGIN
 IF profile IS NULL OR jsonb_typeof(profile)<>'object' OR profile-ARRAY['title','note','currency','effective_from','effective_until','lines']<>'{}'::jsonb OR
  jsonb_typeof(profile->'title') IS DISTINCT FROM 'string' OR char_length(profile->>'title') NOT BETWEEN 1 AND 200 OR profile->>'title'<>btrim(profile->>'title') OR profile->>'title'~'[[:cntrl:]]' OR
  jsonb_typeof(profile->'note') IS DISTINCT FROM 'string' OR char_length(profile->>'note')>2000 OR replace(profile->>'note',E'\n','')~'[[:cntrl:]]' OR
  jsonb_typeof(profile->'currency') IS DISTINCT FROM 'string' OR jsonb_typeof(profile->'lines') IS DISTINCT FROM 'array' THEN RAISE invalid_parameter_value; END IF;
 IF jsonb_array_length(profile->'lines') NOT BETWEEN 1 AND 50 THEN RAISE invalid_parameter_value; END IF;
 SELECT bc.exponent INTO exponent FROM app.billing_currencies bc WHERE bc.code=profile->>'currency';
 IF NOT FOUND THEN RAISE invalid_parameter_value; END IF;
 start_day:=app.pricing_date(profile->'effective_from',false);end_day:=app.pricing_date(profile->'effective_until',true);
 IF end_day<=start_day THEN RAISE invalid_parameter_value; END IF;
 FOR l IN SELECT value FROM jsonb_array_elements(profile->'lines') LOOP
  IF jsonb_typeof(l)<>'object' OR l-ARRAY['description','kind','frequency','quantity_micros','unit_price_minor','discount_bps','tax_bps','unit_cost_minor']<>'{}'::jsonb OR
   jsonb_typeof(l->'description') IS DISTINCT FROM 'string' OR char_length(l->>'description') NOT BETWEEN 1 AND 200 OR l->>'description'<>btrim(l->>'description') OR l->>'description'~'[[:cntrl:]]' OR
   jsonb_typeof(l->'kind') IS DISTINCT FROM 'string' OR l->>'kind' NOT IN ('recurring','one_time','custom') OR
   jsonb_typeof(l->'frequency') IS DISTINCT FROM 'string' OR l->>'frequency' NOT IN ('none','weekly','monthly','quarterly','yearly') OR
   (l->>'kind'='recurring' AND l->>'frequency'='none') OR (l->>'kind'='one_time' AND l->>'frequency'<>'none') THEN RAISE invalid_parameter_value; END IF;
  q:=app.pricing_integer(l->'quantity_micros',true);u:=app.pricing_integer(l->'unit_price_minor',false);
  d:=app.pricing_integer(l->'discount_bps',false,10000);t:=app.pricing_integer(l->'tax_bps',false,10000);
  c:=NULL;IF l->'unit_cost_minor' IS NOT NULL AND l->'unit_cost_minor'<>'null'::jsonb THEN c:=app.pricing_integer(l->'unit_cost_minor',false); ELSE known:=false; END IF;
  b:=round(q::numeric*u/1000000);discount:=round(b*d/10000);net:=b-discount;tax:=round(net*t/10000);total:=net+tax;cost:=round(q::numeric*c/1000000);
  sb:=sb+b;sd:=sd+discount;sn:=sn+net;st:=st+tax;sa:=sa+total;sc:=sc+coalesce(cost,0);
  IF greatest(sb,sd,sn,st,sa,sc)>9223372036854775807 THEN RAISE numeric_value_out_of_range; END IF;
  lines:=lines||jsonb_build_array(l||jsonb_build_object('position',jsonb_array_length(lines)+1,'base_minor',b::bigint::text,'discount_minor',discount::bigint::text,'net_minor',net::bigint::text,'tax_minor',tax::bigint::text,'total_minor',total::bigint::text,'cost_minor',cost::bigint::text));
 END LOOP;
 RETURN jsonb_build_object('currency',profile->>'currency','currency_exponent',exponent,'lines',lines,'base_minor',sb::bigint::text,'discount_minor',sd::bigint::text,'net_minor',sn::bigint::text,'tax_minor',st::bigint::text,'total_minor',sa::bigint::text,'cost_minor',CASE WHEN known THEN sc::bigint::text END);
END; $$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION app.pricing_version_document(target uuid,include_cost boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',v.id,'sheet_id',v.sheet_id,'client_id',v.client_id,'revision',v.revision::text,'title',v.title,'note',v.note,
  'effective_from',to_char(v.effective_from,'YYYY-MM-DD'),'effective_until',to_char(v.effective_until,'YYYY-MM-DD'),
  'window_until',to_char(least(v.effective_until,(SELECT n.effective_from FROM app.pricing_versions n WHERE n.sheet_id=v.sheet_id AND n.revision=v.revision+1)),'YYYY-MM-DD'),
  'created_by',v.created_by,'created_at',v.created_at,'currency',v.currency,'currency_exponent',s.currency_exponent,
  'base_minor',v.base_minor::text,'discount_minor',v.discount_minor::text,'net_minor',v.net_minor::text,'tax_minor',v.tax_minor::text,'total_minor',v.total_minor::text,
  'lines',coalesce((SELECT jsonb_agg((jsonb_build_object('position',l.position,'description',l.description,'kind',l.kind,'frequency',l.frequency,'quantity_micros',l.quantity_micros::text,'unit_price_minor',l.unit_price_minor::text,'discount_bps',l.discount_bps::text,'tax_bps',l.tax_bps::text,'base_minor',l.base_minor::text,'discount_minor',l.discount_minor::text,'net_minor',l.net_minor::text,'tax_minor',l.tax_minor::text,'total_minor',l.total_minor::text)||CASE WHEN include_cost THEN jsonb_build_object('unit_cost_minor',l.unit_cost_minor::text,'cost_minor',l.cost_minor::text) ELSE '{}'::jsonb END) ORDER BY position) FROM app.pricing_lines l WHERE l.version_id=v.id),'[]'::jsonb))
  ||CASE WHEN include_cost THEN jsonb_build_object('cost_minor',v.cost_minor::text) ELSE '{}'::jsonb END
 FROM app.pricing_versions v JOIN app.pricing_sheets s ON s.id=v.sheet_id WHERE v.id=target;
$$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.pricing_read(actor uuid,client uuid,target uuid,version uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s app.pricing_sheets%ROWTYPE; v uuid; costs boolean;
BEGIN
 IF NOT app.authorization_allowed(actor,'pricing.view',client) THEN RETURN NULL; END IF;
 SELECT * INTO s FROM app.pricing_sheets WHERE id=target AND client_id=client;
 IF NOT FOUND THEN RETURN NULL; END IF;
 costs:=app.authorization_allowed(actor,'pricing.manage',client);
 IF version IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM app.pricing_versions WHERE id=version AND sheet_id=target) THEN RETURN NULL; END IF;
  RETURN app.pricing_version_document(version,costs);
 END IF;
 SELECT id INTO v FROM app.pricing_versions WHERE sheet_id=target AND revision=s.revision;
 RETURN jsonb_build_object('id',s.id,'client_id',s.client_id,'revision',s.revision::text,'latest_version',app.pricing_version_document(v,costs));
END; $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.pricing_list(actor uuid,client uuid,target uuid,after_id uuid,page_limit integer) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT app.authorization_allowed(actor,'pricing.view',client) OR NOT EXISTS(SELECT 1 FROM app.clients WHERE id=client) OR
  (target IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.pricing_sheets WHERE id=target AND client_id=client)) THEN RAISE no_data_found; END IF;
 IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 101 THEN RAISE invalid_parameter_value; END IF;
 IF target IS NULL THEN RETURN QUERY SELECT app.pricing_read(actor,client,s.id,NULL) FROM app.pricing_sheets s WHERE s.client_id=client AND (after_id IS NULL OR s.id>after_id) ORDER BY s.id LIMIT page_limit;
 ELSE RETURN QUERY SELECT app.pricing_version_document(v.id,app.authorization_allowed(actor,'pricing.manage',client)) FROM app.pricing_versions v WHERE v.sheet_id=target AND (after_id IS NULL OR v.id>after_id) ORDER BY v.id LIMIT page_limit; END IF;
END; $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.pricing_preview(actor uuid,client uuid,profile jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT app.authorization_allowed(actor,'pricing.view',client) OR NOT app.authorization_allowed(actor,'pricing.manage',client) OR NOT EXISTS(SELECT 1 FROM app.clients WHERE id=client) THEN RAISE no_data_found; END IF;
 IF EXISTS(SELECT 1 FROM app.clients WHERE id=client AND archived_at IS NOT NULL) THEN RAISE EXCEPTION 'Archived client' USING ERRCODE='P0001'; END IF;
 RETURN app.pricing_calculate(profile);
END; $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.pricing_write(actor uuid,client uuid,target uuid,version uuid,expected bigint,profile jsonb)
RETURNS TABLE(code text,before_state jsonb,after_state jsonb,new_revision bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s app.pricing_sheets%ROWTYPE; calc jsonb; l jsonb; rev bigint; start_day date; last_day date;
BEGIN
 PERFORM pg_advisory_xact_lock(871092650209);
 IF NOT app.authorization_allowed(actor,'pricing.view',client) OR NOT app.authorization_allowed(actor,'pricing.manage',client) OR NOT EXISTS(SELECT 1 FROM app.clients WHERE id=client) THEN RAISE no_data_found; END IF;
 IF target IS NULL OR version IS NULL OR target='00000000-0000-0000-0000-000000000000' OR version='00000000-0000-0000-0000-000000000000' OR expected IS NULL OR expected<0 OR expected=9223372036854775807 THEN RAISE invalid_parameter_value; END IF;
 IF EXISTS(SELECT 1 FROM app.clients WHERE id=client AND archived_at IS NOT NULL) THEN RAISE EXCEPTION 'Archived client' USING ERRCODE='P0001'; END IF;
 calc:=app.pricing_calculate(profile);start_day:=app.pricing_date(profile->'effective_from',false);rev:=expected+1;
 IF expected=0 THEN
  INSERT INTO app.pricing_sheets VALUES(target,client,profile->>'currency',(calc->>'currency_exponent')::smallint,1);
 ELSE
  SELECT * INTO s FROM app.pricing_sheets WHERE id=target AND client_id=client FOR UPDATE;
  IF NOT FOUND THEN RAISE no_data_found; END IF;
  SELECT effective_from INTO last_day FROM app.pricing_versions WHERE sheet_id=target AND revision=s.revision;
  IF s.revision<>expected OR s.currency<>profile->>'currency' OR start_day<last_day OR start_day<(statement_timestamp() AT TIME ZONE 'UTC')::date THEN RAISE EXCEPTION 'Stale revision or pricing window' USING ERRCODE='P0001'; END IF;
  UPDATE app.pricing_sheets SET revision=rev WHERE id=target;
 END IF;
 INSERT INTO app.pricing_versions(id,sheet_id,client_id,currency,revision,title,note,effective_from,effective_until,created_by,base_minor,discount_minor,net_minor,tax_minor,total_minor,cost_minor)
 VALUES(version,target,client,profile->>'currency',rev,profile->>'title',profile->>'note',start_day,app.pricing_date(profile->'effective_until',true),actor,(calc->>'base_minor')::bigint,(calc->>'discount_minor')::bigint,(calc->>'net_minor')::bigint,(calc->>'tax_minor')::bigint,(calc->>'total_minor')::bigint,(calc->>'cost_minor')::bigint);
 FOR l IN SELECT value FROM jsonb_array_elements(calc->'lines') LOOP
  INSERT INTO app.pricing_lines VALUES(version,(l->>'position')::integer,l->>'description',l->>'kind',l->>'frequency',(l->>'quantity_micros')::bigint,(l->>'unit_price_minor')::bigint,(l->>'discount_bps')::integer,(l->>'tax_bps')::integer,(l->>'unit_cost_minor')::bigint,(l->>'base_minor')::bigint,(l->>'discount_minor')::bigint,(l->>'net_minor')::bigint,(l->>'tax_minor')::bigint,(l->>'total_minor')::bigint,(l->>'cost_minor')::bigint);
 END LOOP;
 RETURN QUERY SELECT 'ok'::text,CASE WHEN expected=0 THEN 'null'::jsonb ELSE jsonb_build_object('exists',true,'revision',expected) END,jsonb_build_object('exists',true,'revision',rev),rev;
END; $$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION app.pricing_copy(actor uuid,client uuid,target uuid,version uuid,expected bigint,profile jsonb,new_collection uuid)
RETURNS TABLE(code text,before_state jsonb,after_state jsonb,collection_id uuid,new_revision bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s app.pricing_sheets%ROWTYPE; v app.pricing_versions%ROWTYPE; prior app.pricing_snapshots%ROWTYPE; command uuid; day date; due date; result record;
BEGIN
 PERFORM pg_advisory_xact_lock(871092650209);
 IF NOT app.authorization_allowed(actor,'pricing.view',client) OR NOT app.authorization_allowed(actor,'billing.view',client) OR NOT app.authorization_allowed(actor,'billing.create',client) OR NOT EXISTS(SELECT 1 FROM app.clients WHERE id=client) THEN RAISE no_data_found; END IF;
 IF expected IS NULL OR expected<1 OR profile IS NULL OR jsonb_typeof(profile)<>'object' OR profile-ARRAY['command_id','billing_date','due_date','internal_note']<>'{}'::jsonb OR
  jsonb_typeof(profile->'command_id') IS DISTINCT FROM 'string' OR profile->>'command_id' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' OR
  jsonb_typeof(profile->'internal_note') IS DISTINCT FROM 'string' OR char_length(profile->>'internal_note')>8000 OR replace(profile->>'internal_note',E'\n','')~'[[:cntrl:]]' THEN RAISE invalid_parameter_value; END IF;
 command:=(profile->>'command_id')::uuid;day:=app.pricing_date(profile->'billing_date',false);due:=app.pricing_date(profile->'due_date',true);
 IF command='00000000-0000-0000-0000-000000000000' OR day>(statement_timestamp() AT TIME ZONE 'UTC')::date THEN RAISE invalid_parameter_value; END IF;
 SELECT * INTO prior FROM app.pricing_snapshots WHERE client_id=client AND command_id=command;
 IF FOUND THEN
  IF (prior.created_by,prior.sheet_id,prior.version_id,prior.expected_revision,prior.billing_date,prior.original_due_date,prior.original_internal_note) IS DISTINCT FROM (actor,target,version,expected,day,due,profile->>'internal_note') THEN RAISE EXCEPTION 'Command reused' USING ERRCODE='P0001'; END IF;
  RETURN QUERY SELECT 'replay'::text,NULL::jsonb,NULL::jsonb,prior.collection_id,c.revision FROM app.collections c WHERE c.id=prior.collection_id;RETURN;
 END IF;
 SELECT * INTO s FROM app.pricing_sheets WHERE id=target AND client_id=client FOR UPDATE;
 IF NOT FOUND THEN RAISE no_data_found; END IF;
 SELECT * INTO v FROM app.pricing_versions WHERE id=version AND sheet_id=target;
 IF NOT FOUND THEN RAISE no_data_found; END IF;
 IF s.revision<>expected OR v.total_minor<=0 OR EXISTS(SELECT 1 FROM app.clients WHERE id=client AND archived_at IS NOT NULL) OR
  v.effective_from>day OR v.effective_until<=day OR
  v.revision<>(SELECT max(revision) FROM app.pricing_versions WHERE sheet_id=target AND effective_from<=day) THEN RAISE EXCEPTION 'Stale revision or inactive pricing' USING ERRCODE='P0001'; END IF;
 SELECT * INTO result FROM app.billing_write(actor,client,new_collection,0,'create',jsonb_build_object('description',v.title,'internal_note',profile->>'internal_note','amount_minor',v.total_minor::text,'currency',v.currency,'due_date',to_char(due,'YYYY-MM-DD')),NULL);
 IF result.code<>'ok' THEN RAISE EXCEPTION 'Collection cannot be created' USING ERRCODE='P0001'; END IF;
 INSERT INTO app.pricing_snapshots VALUES(new_collection,client,target,version,v.currency,command,expected,actor,clock_timestamp(),day,due,profile->>'internal_note',v.title,v.base_minor,v.discount_minor,v.net_minor,v.tax_minor,v.total_minor);
 INSERT INTO app.pricing_snapshot_lines SELECT new_collection,position,description,kind,frequency,quantity_micros,unit_price_minor,discount_bps,tax_bps,base_minor,discount_minor,net_minor,tax_minor,total_minor FROM app.pricing_lines WHERE version_id=version;
 RETURN QUERY SELECT 'ok'::text,result.before_state,result.after_state,new_collection,result.new_revision;
END; $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.pricing_snapshot_read(actor uuid,client uuid,target uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb;
BEGIN
 IF NOT app.authorization_allowed(actor,'billing.view',client) THEN RETURN NULL; END IF;
 SELECT jsonb_build_object('collection_id',p.collection_id,'client_id',p.client_id,'sheet_id',p.sheet_id,'version_id',p.version_id,'pricing_revision',v.revision::text,'command_id',p.command_id,'billing_date',to_char(p.billing_date,'YYYY-MM-DD'),'title',p.title,'created_by',p.created_by,'created_at',p.created_at,'currency',p.currency,'currency_exponent',s.currency_exponent,
  'base_minor',p.base_minor::text,'discount_minor',p.discount_minor::text,'net_minor',p.net_minor::text,'tax_minor',p.tax_minor::text,'total_minor',p.total_minor::text,
  'lines',(SELECT jsonb_agg(jsonb_build_object('position',l.position,'description',l.description,'kind',l.kind,'frequency',l.frequency,'quantity_micros',l.quantity_micros::text,'unit_price_minor',l.unit_price_minor::text,'discount_bps',l.discount_bps::text,'tax_bps',l.tax_bps::text,'base_minor',l.base_minor::text,'discount_minor',l.discount_minor::text,'net_minor',l.net_minor::text,'tax_minor',l.tax_minor::text,'total_minor',l.total_minor::text) ORDER BY l.position) FROM app.pricing_snapshot_lines l WHERE l.collection_id=target)) INTO result
 FROM app.pricing_snapshots p JOIN app.pricing_versions v ON v.id=p.version_id JOIN app.pricing_sheets s ON s.id=p.sheet_id WHERE p.collection_id=target AND p.client_id=client;
 RETURN result;
END; $$;
-- +goose StatementEnd
REVOKE ALL ON FUNCTION app.pricing_history_guard(),app.pricing_insert_guard(),app.pricing_amount_guard(),app.pricing_consistency_guard(),app.pricing_integer(jsonb,boolean,numeric),app.pricing_date(jsonb,boolean),app.pricing_calculate(jsonb),app.pricing_version_document(uuid,boolean),
 app.pricing_read(uuid,uuid,uuid,uuid),app.pricing_list(uuid,uuid,uuid,uuid,integer),app.pricing_preview(uuid,uuid,jsonb),app.pricing_write(uuid,uuid,uuid,uuid,bigint,jsonb),app.pricing_copy(uuid,uuid,uuid,uuid,bigint,jsonb,uuid),app.pricing_snapshot_read(uuid,uuid,uuid) FROM PUBLIC;

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM app.pricing_sheets) OR EXISTS(SELECT 1 FROM app.pricing_snapshots) OR EXISTS(SELECT 1 FROM app.audit_events WHERE resource_kind='pricing') THEN
  RAISE EXCEPTION 'Retained pricing history prevents rollback' USING ERRCODE='55000'; END IF;
END; $$;
-- +goose StatementEnd
DROP FUNCTION app.pricing_snapshot_read(uuid,uuid,uuid),app.pricing_copy(uuid,uuid,uuid,uuid,bigint,jsonb,uuid),app.pricing_write(uuid,uuid,uuid,uuid,bigint,jsonb),app.pricing_preview(uuid,uuid,jsonb),app.pricing_list(uuid,uuid,uuid,uuid,integer),app.pricing_read(uuid,uuid,uuid,uuid),app.pricing_version_document(uuid,boolean),app.pricing_calculate(jsonb),app.pricing_date(jsonb,boolean),app.pricing_integer(jsonb,boolean,numeric);
DROP TRIGGER pricing_collection_amount_guard ON app.collections;
DROP TABLE app.pricing_snapshot_lines,app.pricing_snapshots,app.pricing_lines,app.pricing_versions,app.pricing_sheets;
DROP FUNCTION app.pricing_consistency_guard(),app.pricing_history_guard(),app.pricing_insert_guard(),app.pricing_amount_guard();
