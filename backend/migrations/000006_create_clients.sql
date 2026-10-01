-- +goose Up
-- Scope IDs preserve pre-client grant history without inventing client profiles.
CREATE TABLE app.client_scopes (id uuid PRIMARY KEY CHECK (id<>'00000000-0000-0000-0000-000000000000'));
INSERT INTO app.client_scopes SELECT DISTINCT client_id FROM app.user_roles WHERE client_id IS NOT NULL;
ALTER TABLE app.user_roles ADD CONSTRAINT user_roles_client_scope FOREIGN KEY (client_id) REFERENCES app.client_scopes(id);
CREATE TABLE app.clients (
 id uuid PRIMARY KEY REFERENCES app.client_scopes(id),
 name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200 AND name=btrim(name) AND name!~'[[:cntrl:]]'),
 legal_name text NOT NULL DEFAULT '' CHECK (char_length(legal_name)<=200 AND legal_name!~'[[:cntrl:]]'),
 website text NOT NULL DEFAULT '' CHECK (char_length(website)<=2048 AND website!~'[[:cntrl:]]'),
 notes text NOT NULL DEFAULT '' CHECK (char_length(notes)<=4000 AND notes!~'[[:cntrl:]]'),
 revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 archived_at timestamptz,
 CHECK (updated_at>=created_at AND (archived_at IS NULL OR archived_at>=created_at))
);
CREATE INDEX clients_active_id ON app.clients(id) WHERE archived_at IS NULL;
CREATE INDEX clients_archived_id ON app.clients(id) WHERE archived_at IS NOT NULL;
CREATE TABLE app.client_contacts (
 client_id uuid NOT NULL REFERENCES app.clients(id),
 position integer NOT NULL CHECK (position BETWEEN 0 AND 19),
 name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100 AND name!~'[[:cntrl:]]'),
 email text NOT NULL DEFAULT '' CHECK (char_length(email)<=254 AND email!~'[[:cntrl:]]'),
 phone text NOT NULL DEFAULT '' CHECK (char_length(phone)<=40 AND phone!~'[[:cntrl:]]'),
 PRIMARY KEY(client_id,position)
);
CREATE TABLE app.client_tags (
 client_id uuid NOT NULL REFERENCES app.clients(id),
 tag text NOT NULL CHECK (char_length(tag) BETWEEN 1 AND 40 AND tag=btrim(tag) AND tag=lower(tag) AND tag!~'[[:cntrl:]]'),
 PRIMARY KEY(client_id,tag)
);
CREATE INDEX client_tags_lookup ON app.client_tags(tag,client_id);

-- +goose StatementBegin
CREATE FUNCTION app.client_assignment_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.scope_kind<>'client' OR NEW.revoked_at IS NOT NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.scope_kind=NEW.scope_kind AND OLD.client_id=NEW.client_id AND OLD.role_id=NEW.role_id AND OLD.user_id=NEW.user_id AND OLD.revoked_at IS NULL THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(871092650209);
 IF NOT EXISTS (SELECT 1 FROM app.clients WHERE id=NEW.client_id AND archived_at IS NULL) THEN RAISE insufficient_privilege; END IF;
 RETURN NEW;
END; $$;
-- +goose StatementEnd
CREATE TRIGGER client_assignment_boundary BEFORE INSERT OR UPDATE ON app.user_roles FOR EACH ROW EXECUTE FUNCTION app.client_assignment_guard();
ALTER TABLE app.user_roles ENABLE ALWAYS TRIGGER client_assignment_boundary;

-- Trusted helper: no runtime EXECUTE; public profile values never enter audit.
-- +goose StatementBegin
CREATE FUNCTION app.client_document(target uuid,details boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',c.id,'name',c.name,'legal_name',c.legal_name,
  'status',CASE WHEN c.archived_at IS NULL THEN 'active' ELSE 'archived' END,
  'revision',c.revision,'created_at',c.created_at,'updated_at',c.updated_at,'archived_at',c.archived_at,
  'tags',coalesce((SELECT jsonb_agg(t.tag ORDER BY t.tag) FROM app.client_tags t WHERE t.client_id=c.id),'[]'::jsonb))
  || CASE WHEN details THEN jsonb_build_object('website',c.website,'notes',c.notes,
   'contacts',coalesce((SELECT jsonb_agg(jsonb_build_object('name',p.name,'email',p.email,'phone',p.phone) ORDER BY p.position)
    FROM app.client_contacts p WHERE p.client_id=c.id),'[]'::jsonb)) ELSE '{}'::jsonb END
 FROM app.clients c WHERE c.id=target;
$$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.client_read(actor uuid,target uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT app.authorization_allowed(actor,'clients.view',target) THEN RETURN NULL; END IF;
 RETURN app.client_document(target,true);
END; $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.client_list(actor uuid,after_id uuid,page_limit integer,state text,search text,tag_filter text,descending boolean) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM app.authorization_grants(actor) WHERE permission_key='clients.view') THEN RAISE insufficient_privilege; END IF;
 IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 101 OR state IS NULL OR state NOT IN ('active','archived','all') OR
  search IS NULL OR char_length(search)>100 OR tag_filter IS NULL OR char_length(tag_filter)>40 OR descending IS NULL THEN RAISE invalid_parameter_value; END IF;
 RETURN QUERY SELECT app.client_document(c.id,false) FROM app.clients c
 WHERE app.authorization_allowed(actor,'clients.view',c.id)
  AND (state='all' OR (state='active' AND c.archived_at IS NULL) OR (state='archived' AND c.archived_at IS NOT NULL))
  AND (search='' OR strpos(lower(c.name),lower(search))>0)
  AND (tag_filter='' OR EXISTS (SELECT 1 FROM app.client_tags t WHERE t.client_id=c.id AND t.tag=tag_filter))
  AND (after_id IS NULL OR (NOT descending AND c.id>after_id) OR (descending AND c.id<after_id))
 ORDER BY CASE WHEN NOT descending THEN c.id END ASC,CASE WHEN descending THEN c.id END DESC LIMIT page_limit;
END; $$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION app.client_write(actor uuid,target uuid,expected bigint,profile jsonb,archive boolean)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE record app.clients%ROWTYPE; permission text;
BEGIN
 PERFORM pg_advisory_xact_lock(871092650209);
 IF expected=0 AND NOT archive THEN
  IF NOT app.authorization_allowed(actor,'clients.create',NULL) THEN RETURN 'denied'; END IF;
 ELSE
  permission:=CASE WHEN archive THEN 'clients.archive' ELSE 'clients.update' END;
  IF NOT app.authorization_allowed(actor,permission,target) THEN RETURN 'missing'; END IF;
  SELECT * INTO record FROM app.clients WHERE id=target FOR UPDATE;
  IF NOT FOUND THEN RETURN 'missing'; END IF;
  IF expected IS NULL OR expected<1 OR record.revision<>expected OR record.archived_at IS NOT NULL THEN RETURN 'conflict'; END IF;
 END IF;
 IF target IS NULL OR target='00000000-0000-0000-0000-000000000000' OR archive IS NULL OR expected IS NULL OR expected<0 THEN RETURN 'invalid'; END IF;
 IF archive THEN
  UPDATE app.clients SET archived_at=clock_timestamp(),updated_at=clock_timestamp(),revision=revision+1 WHERE id=target;
  RETURN 'ok';
 END IF;
 IF profile IS NULL OR jsonb_typeof(profile)<>'object' OR
  profile-ARRAY['name','legal_name','website','notes','contacts','tags']<>'{}'::jsonb OR
  jsonb_typeof(profile->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(profile->'legal_name') IS DISTINCT FROM 'string' OR
  jsonb_typeof(profile->'website') IS DISTINCT FROM 'string' OR jsonb_typeof(profile->'notes') IS DISTINCT FROM 'string' OR
  jsonb_typeof(profile->'contacts') IS DISTINCT FROM 'array' OR jsonb_typeof(profile->'tags') IS DISTINCT FROM 'array' THEN RETURN 'invalid'; END IF;
 IF jsonb_array_length(profile->'contacts')>20 OR jsonb_array_length(profile->'tags')>20 THEN RETURN 'invalid'; END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(profile->'contacts') p WHERE jsonb_typeof(p)<>'object' OR
  p-ARRAY['name','email','phone']<>'{}'::jsonb OR jsonb_typeof(p->'name') IS DISTINCT FROM 'string' OR
  jsonb_typeof(p->'email') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'phone') IS DISTINCT FROM 'string') OR
  EXISTS (SELECT 1 FROM jsonb_array_elements(profile->'tags') p WHERE jsonb_typeof(p)<>'string') THEN RETURN 'invalid'; END IF;
 IF expected=0 THEN
  INSERT INTO app.client_scopes(id) VALUES(target);
  INSERT INTO app.clients(id,name,legal_name,website,notes) VALUES(target,profile->>'name',profile->>'legal_name',profile->>'website',profile->>'notes');
 ELSE
  UPDATE app.clients SET name=profile->>'name',legal_name=profile->>'legal_name',website=profile->>'website',notes=profile->>'notes',revision=revision+1,updated_at=clock_timestamp() WHERE id=target;
  DELETE FROM app.client_contacts WHERE client_id=target;
  DELETE FROM app.client_tags WHERE client_id=target;
 END IF;
 INSERT INTO app.client_contacts(client_id,position,name,email,phone)
 SELECT target,(ordinality-1)::integer,p->>'name',p->>'email',p->>'phone' FROM jsonb_array_elements(profile->'contacts') WITH ORDINALITY AS input(p,ordinality);
 INSERT INTO app.client_tags(client_id,tag) SELECT target,p#>>'{}' FROM jsonb_array_elements(profile->'tags') p;
 RETURN 'ok';
EXCEPTION WHEN check_violation OR not_null_violation OR invalid_text_representation THEN RETURN 'invalid';
 WHEN unique_violation THEN RETURN 'conflict';
END; $$;
-- +goose StatementEnd
REVOKE ALL ON app.client_scopes,app.clients,app.client_contacts,app.client_tags FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.client_assignment_guard(),app.client_document(uuid,boolean),app.client_read(uuid,uuid),
 app.client_list(uuid,uuid,integer,text,text,text,boolean),app.client_write(uuid,uuid,bigint,jsonb,boolean) FROM PUBLIC;

-- +goose Down
LOCK TABLE app.clients,app.client_contacts,app.client_tags,app.user_roles IN ACCESS EXCLUSIVE MODE;
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM app.clients) OR EXISTS (SELECT 1 FROM app.audit_events WHERE resource_kind='client') THEN
  RAISE EXCEPTION 'Rollback refused: client history is not empty';
 END IF;
END; $$;
-- +goose StatementEnd
DROP TRIGGER client_assignment_boundary ON app.user_roles;
DROP FUNCTION app.client_assignment_guard(),app.client_read(uuid,uuid),app.client_list(uuid,uuid,integer,text,text,text,boolean),app.client_write(uuid,uuid,bigint,jsonb,boolean);
DROP FUNCTION app.client_document(uuid,boolean);
ALTER TABLE app.user_roles DROP CONSTRAINT user_roles_client_scope;
DROP TABLE app.client_tags,app.client_contacts,app.clients,app.client_scopes;
