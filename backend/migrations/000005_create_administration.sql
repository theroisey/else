-- +goose Up
ALTER TABLE app.users ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE app.roles ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0);

-- A recoverable administrator is defined by capabilities, never a role name.
-- VOLATILE gives fresh reads after the shared advisory lock, including in triggers.
-- +goose StatementBegin
CREATE FUNCTION app.admin_survives(excluded_user uuid, excluded_role_assignment uuid, excluded_permission_assignment uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM app.users u WHERE u.status = 'active'
          AND (excluded_user IS NULL OR u.id <> excluded_user)
          AND (SELECT count(DISTINCT rp.permission_key) FROM app.user_roles ur
               JOIN app.role_permissions rp ON rp.role_id = ur.role_id AND rp.revoked_at IS NULL
               WHERE ur.user_id = u.id AND ur.scope_kind = 'global' AND ur.revoked_at IS NULL
                 AND rp.permission_key IN ('users.manage','roles.manage')
                 AND (excluded_role_assignment IS NULL OR ur.id <> excluded_role_assignment)
                 AND (excluded_permission_assignment IS NULL OR rp.id <> excluded_permission_assignment)) = 2
    );
END;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION app.admin_guard_last() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE excluded_user uuid; excluded_role uuid; excluded_permission uuid;
BEGIN
    PERFORM pg_advisory_xact_lock(871092650209);
    IF TG_TABLE_NAME = 'users' THEN
        IF OLD.status <> 'active' OR NEW.status = 'active' THEN RETURN NEW; END IF;
        excluded_user := OLD.id;
    ELSIF TG_TABLE_NAME = 'user_roles' THEN
        IF OLD.revoked_at IS NOT NULL THEN
            IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
        END IF;
        IF TG_OP = 'UPDATE' THEN
            IF NEW.revoked_at IS NULL AND (NEW.user_id,NEW.role_id,NEW.scope_kind,NEW.client_id) IS NOT DISTINCT FROM
               (OLD.user_id,OLD.role_id,OLD.scope_kind,OLD.client_id) THEN RETURN NEW; END IF;
        END IF;
        excluded_role := OLD.id;
    ELSE
        IF OLD.revoked_at IS NOT NULL THEN
            IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
        END IF;
        IF TG_OP = 'UPDATE' THEN
            IF NEW.revoked_at IS NULL AND (NEW.role_id,NEW.permission_key) IS NOT DISTINCT FROM
               (OLD.role_id,OLD.permission_key) THEN RETURN NEW; END IF;
        END IF;
        excluded_permission := OLD.id;
    END IF;
    IF app.admin_survives(NULL,NULL,NULL) AND NOT app.admin_survives(excluded_user,excluded_role,excluded_permission) THEN
        RAISE EXCEPTION 'Last administrator protected' USING ERRCODE = 'P1001';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER administration_last_user BEFORE UPDATE OF status ON app.users
FOR EACH ROW EXECUTE FUNCTION app.admin_guard_last();
CREATE TRIGGER administration_last_role BEFORE UPDATE OR DELETE ON app.user_roles
FOR EACH ROW EXECUTE FUNCTION app.admin_guard_last();
CREATE TRIGGER administration_last_permission BEFORE UPDATE OR DELETE ON app.role_permissions
FOR EACH ROW EXECUTE FUNCTION app.admin_guard_last();
ALTER TABLE app.users ENABLE ALWAYS TRIGGER administration_last_user;
ALTER TABLE app.user_roles ENABLE ALWAYS TRIGGER administration_last_role;
ALTER TABLE app.role_permissions ENABLE ALWAYS TRIGGER administration_last_permission;

-- Bounded read contracts check the current actor inside the database too.
-- +goose StatementBegin
CREATE FUNCTION app.admin_users(actor uuid, after_id uuid, page_limit integer) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    IF NOT app.authorization_allowed(actor,'users.view',NULL) THEN RAISE insufficient_privilege; END IF;
    IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 101 THEN RAISE invalid_parameter_value; END IF;
    RETURN QUERY SELECT jsonb_build_object('id',u.id,'email',u.email,'display_name',u.display_name,
        'status',u.status,'revision',u.revision,'created_at',u.created_at,'updated_at',u.updated_at,'last_login_at',u.last_login_at)
        FROM app.users u WHERE after_id IS NULL OR u.id > after_id ORDER BY u.id LIMIT page_limit;
END;
$$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.admin_user(actor uuid, target uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    IF NOT app.authorization_allowed(actor,'users.view',NULL) THEN RAISE insufficient_privilege; END IF;
    RETURN (SELECT jsonb_build_object('id',u.id,'email',u.email,'display_name',u.display_name,
        'status',u.status,'revision',u.revision,'created_at',u.created_at,'updated_at',u.updated_at,'last_login_at',u.last_login_at)
        FROM app.users u WHERE u.id = target);
END;
$$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.admin_roles(actor uuid, after_id uuid, page_limit integer) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    IF NOT app.authorization_allowed(actor,'roles.view',NULL) THEN RAISE insufficient_privilege; END IF;
    IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 101 THEN RAISE invalid_parameter_value; END IF;
    RETURN QUERY SELECT jsonb_build_object('id',r.id,'display_name',r.display_name,'system_role',r.system_role,
        'revision',r.revision,'created_at',r.created_at,'updated_at',r.updated_at,
        'permissions',coalesce((SELECT jsonb_agg(rp.permission_key ORDER BY rp.permission_key)
            FROM app.role_permissions rp WHERE rp.role_id=r.id AND rp.revoked_at IS NULL),'[]'::jsonb))
        FROM app.roles r WHERE after_id IS NULL OR r.id > after_id ORDER BY r.id LIMIT page_limit;
END;
$$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.admin_role(actor uuid, target uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    IF NOT app.authorization_allowed(actor,'roles.view',NULL) THEN RAISE insufficient_privilege; END IF;
    RETURN (SELECT jsonb_build_object('id',r.id,'display_name',r.display_name,'system_role',r.system_role,
        'revision',r.revision,'created_at',r.created_at,'updated_at',r.updated_at,
        'permissions',coalesce((SELECT jsonb_agg(rp.permission_key ORDER BY rp.permission_key)
            FROM app.role_permissions rp WHERE rp.role_id=r.id AND rp.revoked_at IS NULL),'[]'::jsonb))
        FROM app.roles r WHERE r.id=target);
END;
$$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.admin_catalog(actor uuid) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    IF NOT app.authorization_allowed(actor,'roles.view',NULL) THEN RAISE insufficient_privilege; END IF;
    RETURN QUERY SELECT jsonb_build_object('permission',p.permission_key,'scope',p.scope_kind,'description',p.description)
        FROM app.permissions p ORDER BY p.permission_key LIMIT 100;
END;
$$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.admin_assignments(actor uuid, target uuid, after_id uuid, page_limit integer) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    IF NOT app.authorization_allowed(actor,'roles.view',NULL) THEN RAISE insufficient_privilege; END IF;
    IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 101 THEN RAISE invalid_parameter_value; END IF;
    RETURN QUERY SELECT jsonb_build_object('id',ur.id,'user_id',ur.user_id,'role_id',ur.role_id,
        'display_name',r.display_name,'scope',ur.scope_kind,'client_id',ur.client_id,'assigned_at',ur.assigned_at)
        FROM app.user_roles ur JOIN app.roles r ON r.id=ur.role_id
        WHERE ur.user_id=target AND ur.revoked_at IS NULL AND (after_id IS NULL OR ur.id > after_id)
        ORDER BY ur.id LIMIT page_limit;
END;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION app.admin_create_user(actor uuid, target uuid, supplied_email text, supplied_name text, supplied_hash text)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(871092650209);
    IF NOT app.authorization_allowed(actor,'users.manage',NULL) THEN RETURN 'denied'; END IF;
    IF supplied_email IS NULL OR supplied_name IS NULL OR supplied_hash IS NULL OR
       target IS NULL OR target='00000000-0000-0000-0000-000000000000' OR
       supplied_hash !~ '^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$' THEN RETURN 'invalid'; END IF;
    INSERT INTO app.users (id,email,display_name,password_hash) VALUES (target,supplied_email,supplied_name,supplied_hash);
    RETURN 'ok';
EXCEPTION WHEN unique_violation THEN RETURN 'conflict';
          WHEN check_violation THEN RETURN 'invalid';
END;
$$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.admin_update_user(actor uuid, target uuid, expected_revision bigint, supplied_email text, supplied_name text)
RETURNS TABLE(outcome text, old_revision bigint, old_status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE record app.users%ROWTYPE;
BEGIN
    PERFORM pg_advisory_xact_lock(871092650209);
    IF NOT app.authorization_allowed(actor,'users.manage',NULL) THEN RETURN QUERY SELECT 'denied'::text,NULL::bigint,NULL::text; RETURN; END IF;
    IF supplied_email IS NULL OR supplied_name IS NULL THEN RETURN QUERY SELECT 'invalid'::text,NULL::bigint,NULL::text; RETURN; END IF;
    SELECT * INTO record FROM app.users WHERE id=target FOR UPDATE;
    IF NOT FOUND THEN RETURN QUERY SELECT 'missing'::text,NULL::bigint,NULL::text; RETURN; END IF;
    IF expected_revision IS NULL OR expected_revision<1 OR record.revision <> expected_revision THEN RETURN QUERY SELECT 'conflict'::text,NULL::bigint,NULL::text; RETURN; END IF;
    UPDATE app.users SET email=supplied_email,display_name=supplied_name,revision=revision+1,updated_at=clock_timestamp() WHERE id=target;
    RETURN QUERY SELECT 'ok'::text,record.revision,record.status;
EXCEPTION WHEN unique_violation THEN RETURN QUERY SELECT 'conflict'::text,NULL::bigint,NULL::text;
          WHEN check_violation THEN RETURN QUERY SELECT 'invalid'::text,NULL::bigint,NULL::text;
END;
$$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.admin_disable_user(actor uuid, target uuid, expected_revision bigint)
RETURNS TABLE(outcome text, old_revision bigint, old_status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE record app.users%ROWTYPE;
BEGIN
    PERFORM pg_advisory_xact_lock(871092650209);
    IF NOT app.authorization_allowed(actor,'users.manage',NULL) THEN RETURN QUERY SELECT 'denied'::text,NULL::bigint,NULL::text; RETURN; END IF;
    IF actor=target THEN RETURN QUERY SELECT 'self_disable'::text,NULL::bigint,NULL::text; RETURN; END IF;
    SELECT * INTO record FROM app.users WHERE id=target FOR UPDATE;
    IF NOT FOUND THEN RETURN QUERY SELECT 'missing'::text,NULL::bigint,NULL::text; RETURN; END IF;
    IF expected_revision IS NULL OR expected_revision<1 OR record.revision <> expected_revision OR record.status='disabled' THEN RETURN QUERY SELECT 'conflict'::text,NULL::bigint,NULL::text; RETURN; END IF;
    UPDATE app.users SET status='disabled',revision=revision+1,updated_at=clock_timestamp() WHERE id=target;
    UPDATE app.sessions SET revoked_at=clock_timestamp() WHERE user_id=target AND revoked_at IS NULL;
    RETURN QUERY SELECT 'ok'::text,record.revision,record.status;
END;
$$;
-- +goose StatementEnd

-- Global control is mandatory: changing a role affects all of its holders.
-- +goose StatementBegin
CREATE FUNCTION app.admin_create_role(actor uuid, target uuid, supplied_name text, supplied_permissions text[])
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(871092650209);
    IF NOT app.authorization_allowed(actor,'roles.manage',NULL) THEN RETURN 'denied'; END IF;
    IF supplied_name IS NULL OR target IS NULL OR target='00000000-0000-0000-0000-000000000000' OR
       supplied_permissions IS NULL OR cardinality(supplied_permissions) NOT BETWEEN 1 AND 100 OR
       cardinality(supplied_permissions) <> (SELECT count(DISTINCT p) FROM unnest(supplied_permissions) p) THEN RETURN 'invalid'; END IF;
    IF EXISTS (SELECT 1 FROM unnest(supplied_permissions) p WHERE
       NOT EXISTS (SELECT 1 FROM app.permissions WHERE permission_key=p) OR
       NOT EXISTS (SELECT 1 FROM app.authorization_grants(actor) g WHERE g.permission_key=p AND g.scope_kind='global')) THEN RETURN 'denied'; END IF;
    INSERT INTO app.roles (id,role_key,display_name,system_role) VALUES
        (target,'custom_'||substr(replace(target::text,'-',''),1,24),supplied_name,false);
    INSERT INTO app.role_permissions (id,role_id,permission_key) SELECT gen_random_uuid(),target,p FROM unnest(supplied_permissions) p;
    RETURN 'ok';
EXCEPTION WHEN unique_violation THEN RETURN 'conflict';
          WHEN check_violation THEN RETURN 'invalid';
END;
$$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.admin_replace_permissions(actor uuid, target uuid, expected_revision bigint, supplied_permissions text[])
RETURNS TABLE(outcome text, old_revision bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE record app.roles%ROWTYPE;
BEGIN
    PERFORM pg_advisory_xact_lock(871092650209);
    IF NOT app.authorization_allowed(actor,'roles.manage',NULL) THEN RETURN QUERY SELECT 'denied'::text,NULL::bigint; RETURN; END IF;
    SELECT * INTO record FROM app.roles WHERE id=target FOR UPDATE;
    IF NOT FOUND THEN RETURN QUERY SELECT 'missing'::text,NULL::bigint; RETURN; END IF;
    IF record.system_role THEN RETURN QUERY SELECT 'system_role'::text,NULL::bigint; RETURN; END IF;
    IF expected_revision IS NULL OR expected_revision<1 OR record.revision <> expected_revision THEN RETURN QUERY SELECT 'conflict'::text,NULL::bigint; RETURN; END IF;
    IF supplied_permissions IS NULL OR cardinality(supplied_permissions) NOT BETWEEN 1 AND 100 OR
       cardinality(supplied_permissions) <> (SELECT count(DISTINCT p) FROM unnest(supplied_permissions) p) THEN
        RETURN QUERY SELECT 'invalid'::text,NULL::bigint; RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM (
        SELECT p AS key FROM unnest(supplied_permissions) p UNION
        SELECT rp.permission_key FROM app.role_permissions rp WHERE rp.role_id=target AND rp.revoked_at IS NULL
    ) affected WHERE NOT EXISTS (SELECT 1 FROM app.permissions WHERE permission_key=affected.key) OR
        NOT EXISTS (SELECT 1 FROM app.authorization_grants(actor) g WHERE g.permission_key=affected.key AND g.scope_kind='global')) THEN
        RETURN QUERY SELECT 'denied'::text,NULL::bigint; RETURN;
    END IF;
    INSERT INTO app.role_permissions (id,role_id,permission_key)
        SELECT gen_random_uuid(),target,p FROM unnest(supplied_permissions) p
        WHERE NOT EXISTS (SELECT 1 FROM app.role_permissions rp WHERE rp.role_id=target AND rp.permission_key=p AND rp.revoked_at IS NULL);
    UPDATE app.role_permissions SET revoked_at=clock_timestamp()
        WHERE role_id=target AND revoked_at IS NULL AND NOT (permission_key=ANY(supplied_permissions));
    UPDATE app.roles SET revision=revision+1,updated_at=clock_timestamp() WHERE id=target;
    RETURN QUERY SELECT 'ok'::text,record.revision;
END;
$$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.admin_revoke_assignment(actor uuid, target uuid, assignment uuid, revoked_time timestamptz)
RETURNS TABLE(changed boolean, client_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(871092650209);
    IF NOT EXISTS (SELECT 1 FROM app.user_roles WHERE id=assignment AND user_id=target AND revoked_at IS NULL) THEN
        RETURN QUERY SELECT false,NULL::uuid; RETURN;
    END IF;
    RETURN QUERY SELECT * FROM app.revoke_role_assignment(actor,assignment,revoked_time);
END;
$$;
-- +goose StatementEnd

REVOKE ALL ON FUNCTION app.admin_survives(uuid,uuid,uuid),app.admin_guard_last(),
    app.admin_users(uuid,uuid,integer),app.admin_user(uuid,uuid),app.admin_roles(uuid,uuid,integer),app.admin_role(uuid,uuid),
    app.admin_catalog(uuid),app.admin_assignments(uuid,uuid,uuid,integer),
    app.admin_create_user(uuid,uuid,text,text,text),app.admin_update_user(uuid,uuid,bigint,text,text),
    app.admin_disable_user(uuid,uuid,bigint),app.admin_create_role(uuid,uuid,text,text[]),
    app.admin_replace_permissions(uuid,uuid,bigint,text[]),app.admin_revoke_assignment(uuid,uuid,uuid,timestamptz)
FROM PUBLIC;

-- Add only typed account status to snapshots; credential/profile strings stay forbidden.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.audit_snapshot_allowed(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
BEGIN
    IF value='null'::jsonb THEN RETURN true; END IF;
    IF jsonb_typeof(value)<>'object' OR value-ARRAY['exists','revision','status']<>'{}'::jsonb THEN RETURN false; END IF;
    IF value ? 'exists' AND jsonb_typeof(value->'exists')<>'boolean' THEN RETURN false; END IF;
    IF value ? 'status' AND (jsonb_typeof(value->'status')<>'string' OR value->>'status' NOT IN ('active','disabled')) THEN RETURN false; END IF;
    IF value ? 'revision' THEN
        IF jsonb_typeof(value->'revision')<>'number' OR value->>'revision' !~ '^(0|[1-9][0-9]*)$' THEN RETURN false; END IF;
        IF (value->>'revision')::numeric > 9223372036854775807 THEN RETURN false; END IF;
    END IF;
    RETURN true;
END;
$$;
-- +goose StatementEnd
-- +goose StatementBegin
DO $$ DECLARE constraint_name text;
BEGIN
    FOR constraint_name IN SELECT conname FROM pg_constraint WHERE conrelid='app.audit_events'::regclass AND contype='c'
        AND pg_get_constraintdef(oid) LIKE '%event_name%' LOOP
        EXECUTE format('ALTER TABLE app.audit_events DROP CONSTRAINT %I',constraint_name);
    END LOOP;
END;
$$;
-- +goose StatementEnd
ALTER TABLE app.audit_events ADD CONSTRAINT audit_event_action CHECK (
    event_name IN (resource_kind||'.created',resource_kind||'.updated',resource_kind||'.archived',resource_kind||'.deleted') OR
    (resource_kind='user' AND event_name='user.disabled') OR (resource_kind='role' AND event_name='role.permission_changed'));

-- +goose Down
LOCK TABLE app.users,app.roles,app.user_roles,app.role_permissions,app.audit_events IN ACCESS EXCLUSIVE MODE;
-- +goose StatementBegin
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM app.users) OR EXISTS (SELECT 1 FROM app.roles WHERE NOT system_role) OR
       EXISTS (SELECT 1 FROM app.audit_events WHERE event_name IN ('user.disabled','role.permission_changed') OR
               before_state ? 'status' OR after_state ? 'status') THEN
        RAISE EXCEPTION 'Rollback refused: administration/security history is not empty';
    END IF;
END; $$;
-- +goose StatementEnd
DROP TRIGGER administration_last_user ON app.users;
DROP TRIGGER administration_last_role ON app.user_roles;
DROP TRIGGER administration_last_permission ON app.role_permissions;
DROP FUNCTION app.admin_guard_last();
DROP FUNCTION app.admin_survives(uuid,uuid,uuid);
DROP FUNCTION app.admin_users(uuid,uuid,integer),app.admin_user(uuid,uuid),app.admin_roles(uuid,uuid,integer),app.admin_role(uuid,uuid),
    app.admin_catalog(uuid),app.admin_assignments(uuid,uuid,uuid,integer),
    app.admin_create_user(uuid,uuid,text,text,text),app.admin_update_user(uuid,uuid,bigint,text,text),
    app.admin_disable_user(uuid,uuid,bigint),app.admin_create_role(uuid,uuid,text,text[]),
    app.admin_replace_permissions(uuid,uuid,bigint,text[]),app.admin_revoke_assignment(uuid,uuid,uuid,timestamptz);
ALTER TABLE app.users DROP COLUMN revision;
ALTER TABLE app.roles DROP COLUMN revision;
ALTER TABLE app.audit_events DROP CONSTRAINT audit_event_action;
ALTER TABLE app.audit_events ADD CONSTRAINT audit_event_action CHECK (event_name IN
    (resource_kind||'.created',resource_kind||'.updated',resource_kind||'.archived',resource_kind||'.deleted'));
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.audit_snapshot_allowed(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
BEGIN
    IF value='null'::jsonb THEN RETURN true; END IF;
    IF jsonb_typeof(value)<>'object' OR value-ARRAY['exists','revision']<>'{}'::jsonb THEN RETURN false; END IF;
    IF value ? 'exists' AND jsonb_typeof(value->'exists')<>'boolean' THEN RETURN false; END IF;
    IF value ? 'revision' THEN
        IF jsonb_typeof(value->'revision')<>'number' OR value->>'revision' !~ '^(0|[1-9][0-9]*)$' THEN RETURN false; END IF;
        IF (value->>'revision')::numeric > 9223372036854775807 THEN RETURN false; END IF;
    END IF;
    RETURN true;
END;
$$;
-- +goose StatementEnd
