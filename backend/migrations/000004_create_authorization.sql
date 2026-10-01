-- +goose Up
CREATE TABLE app.permissions (
    permission_key text PRIMARY KEY CHECK (permission_key ~ '^[a-z][a-z0-9_]{0,31}\.[a-z][a-z0-9_]{0,31}$'),
    scope_kind text NOT NULL CHECK (scope_kind IN ('global', 'client')),
    description text NOT NULL CHECK (description = btrim(description) AND char_length(description) BETWEEN 1 AND 160)
);

CREATE TABLE app.roles (
    id uuid PRIMARY KEY,
    role_key text NOT NULL UNIQUE CHECK (role_key ~ '^[a-z][a-z0-9_]{0,31}$'),
    display_name text NOT NULL CHECK (display_name = btrim(display_name) AND char_length(display_name) BETWEEN 1 AND 100),
    system_role boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (updated_at >= created_at)
);

CREATE TABLE app.role_permissions (
    id uuid PRIMARY KEY,
    role_id uuid NOT NULL REFERENCES app.roles(id) ON DELETE RESTRICT,
    permission_key text NOT NULL REFERENCES app.permissions(permission_key) ON DELETE RESTRICT,
    seeded boolean NOT NULL DEFAULT false,
    assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    revoked_at timestamptz,
    CHECK (revoked_at IS NULL OR revoked_at >= assigned_at)
);
CREATE UNIQUE INDEX role_permissions_active ON app.role_permissions (role_id, permission_key)
    WHERE revoked_at IS NULL;

CREATE TABLE app.user_roles (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
    role_id uuid NOT NULL REFERENCES app.roles(id) ON DELETE RESTRICT,
    scope_kind text NOT NULL CHECK (scope_kind IN ('global', 'client')),
    client_id uuid,
    assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    revoked_at timestamptz,
    CHECK ((scope_kind = 'global' AND client_id IS NULL) OR
           (scope_kind = 'client' AND client_id IS NOT NULL AND client_id <> '00000000-0000-0000-0000-000000000000')),
    CHECK (revoked_at IS NULL OR revoked_at >= assigned_at)
);
CREATE UNIQUE INDEX user_roles_active_global ON app.user_roles (user_id, role_id)
    WHERE scope_kind = 'global' AND revoked_at IS NULL;
CREATE UNIQUE INDEX user_roles_active_client ON app.user_roles (user_id, role_id, client_id)
    WHERE scope_kind = 'client' AND revoked_at IS NULL;
CREATE INDEX user_roles_active_user ON app.user_roles (user_id, scope_kind, client_id)
    WHERE revoked_at IS NULL;

INSERT INTO app.permissions (permission_key, scope_kind, description) VALUES
    ('users.view',          'global', 'View user identities'),
    ('users.manage',        'global', 'Create and maintain user identities'),
    ('roles.view',          'global', 'View roles and permission assignments'),
    ('roles.manage',        'global', 'Maintain roles and permission assignments'),
    ('audit.view',          'global', 'View immutable audit history'),
    ('releases.view',       'global', 'View release status'),
    ('releases.manage',     'global', 'Manage release operations'),
    ('clients.create',      'global', 'Create client records'),
    ('clients.view',        'client', 'View client records'),
    ('clients.update',      'client', 'Update client records'),
    ('clients.archive',     'client', 'Archive client records'),
    ('billing.view',        'client', 'View client billing records'),
    ('billing.manage',      'client', 'Manage client billing records'),
    ('pricing.view',        'client', 'View client pricing'),
    ('pricing.manage',      'client', 'Manage client pricing'),
    ('tasks.view',          'client', 'View client tasks'),
    ('tasks.manage',        'client', 'Manage client tasks'),
    ('analytics.view',      'client', 'View client analytics'),
    ('integrations.manage', 'client', 'Manage client integrations');

INSERT INTO app.roles (id, role_key, display_name, system_role) VALUES
    ('00000000-0000-4000-8000-000000000001', 'initial_administrator', 'Initial Administrator', true),
    ('00000000-0000-4000-8000-000000000002', 'finance', 'Finance', true),
    ('00000000-0000-4000-8000-000000000003', 'viewer', 'Viewer', true);

INSERT INTO app.role_permissions (id, role_id, permission_key, seeded)
SELECT gen_random_uuid(), '00000000-0000-4000-8000-000000000001'::uuid, permission_key, true FROM app.permissions;
INSERT INTO app.role_permissions (id, role_id, permission_key, seeded) VALUES
    (gen_random_uuid(), '00000000-0000-4000-8000-000000000002', 'clients.view', true),
    (gen_random_uuid(), '00000000-0000-4000-8000-000000000002', 'billing.view', true),
    (gen_random_uuid(), '00000000-0000-4000-8000-000000000002', 'billing.manage', true),
    (gen_random_uuid(), '00000000-0000-4000-8000-000000000002', 'pricing.view', true),
    (gen_random_uuid(), '00000000-0000-4000-8000-000000000003', 'clients.view', true),
    (gen_random_uuid(), '00000000-0000-4000-8000-000000000003', 'billing.view', true),
    (gen_random_uuid(), '00000000-0000-4000-8000-000000000003', 'pricing.view', true),
    (gen_random_uuid(), '00000000-0000-4000-8000-000000000003', 'tasks.view', true),
    (gen_random_uuid(), '00000000-0000-4000-8000-000000000003', 'analytics.view', true);

-- Existing bootstrap identities are migrated into ordinary RBAC assignments.
WITH assignments AS (
    INSERT INTO app.user_roles (id, user_id, role_id, scope_kind)
    SELECT gen_random_uuid(), id, '00000000-0000-4000-8000-000000000001', 'global'
    FROM app.users WHERE bootstrap_admin
    RETURNING id
)
INSERT INTO app.audit_events
    (actor_kind, actor_user_id, event_name, resource_kind, resource_id, client_id,
     request_id, before_state, after_state, metadata)
SELECT 'system', NULL, 'role_assignment.created', 'role_assignment', id, NULL,
       'AAAAAAAAAAAAAAAAAAAAAAAAAA', 'null', '{"exists":true}', '{"source":"cli"}'
FROM assignments;

-- Flattened effective grants. A client assignment deliberately omits global
-- permissions even if its role contains them.
-- +goose StatementBegin
CREATE FUNCTION app.authorization_grants(candidate_user uuid)
RETURNS TABLE(permission_key text, scope_kind text, client_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT DISTINCT p.permission_key,
           CASE WHEN ur.scope_kind = 'global' THEN 'global' ELSE 'client' END,
           ur.client_id
    FROM app.users u
    JOIN app.user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
    JOIN app.role_permissions rp ON rp.role_id = ur.role_id AND rp.revoked_at IS NULL
    JOIN app.permissions p ON p.permission_key = rp.permission_key
    WHERE u.id = candidate_user AND u.status = 'active'
      AND (ur.scope_kind = 'global' OR p.scope_kind = 'client');
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION app.authorization_allowed(candidate_user uuid, candidate_permission text, candidate_client uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT EXISTS (
        SELECT 1
        FROM app.users u
        JOIN app.user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
        JOIN app.role_permissions rp ON rp.role_id = ur.role_id AND rp.revoked_at IS NULL
        JOIN app.permissions p ON p.permission_key = rp.permission_key
        WHERE u.id = candidate_user AND u.status = 'active'
          AND p.permission_key = candidate_permission
          AND ((p.scope_kind = 'global' AND candidate_client IS NULL AND ur.scope_kind = 'global') OR
               (p.scope_kind = 'client' AND candidate_client IS NOT NULL AND
                (ur.scope_kind = 'global' OR (ur.scope_kind = 'client' AND ur.client_id = candidate_client))))
    );
$$;
-- +goose StatementEnd

-- The actor needs global role administration plus every permission that the
-- requested assignment would make effective.
-- +goose StatementBegin
CREATE FUNCTION app.create_role_assignment(
    actor_id uuid, target_id uuid, requested_role uuid, requested_scope text,
    requested_client uuid, assignment_id uuid, assigned_time timestamptz)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(871092650209);
    IF assignment_id IS NULL OR assignment_id = '00000000-0000-0000-0000-000000000000' OR
       requested_scope NOT IN ('global', 'client') OR
       (requested_scope = 'global' AND requested_client IS NOT NULL) OR
       (requested_scope = 'client' AND (requested_client IS NULL OR requested_client = '00000000-0000-0000-0000-000000000000')) OR
       NOT app.authorization_allowed(actor_id, 'roles.manage', NULL) OR
       NOT EXISTS (SELECT 1 FROM app.users WHERE id = target_id AND status = 'active') OR
       NOT EXISTS (SELECT 1 FROM app.roles WHERE id = requested_role) OR
       NOT EXISTS (
           SELECT 1 FROM app.role_permissions rp JOIN app.permissions p ON p.permission_key = rp.permission_key
           WHERE rp.role_id = requested_role AND rp.revoked_at IS NULL AND (requested_scope = 'global' OR p.scope_kind = 'client')
       ) OR EXISTS (
           SELECT 1 FROM app.role_permissions rp JOIN app.permissions p ON p.permission_key = rp.permission_key
           WHERE rp.role_id = requested_role AND rp.revoked_at IS NULL AND (requested_scope = 'global' OR p.scope_kind = 'client')
             AND NOT CASE
                 WHEN requested_scope = 'global' THEN EXISTS (
                     SELECT 1 FROM app.authorization_grants(actor_id) g
                     WHERE g.permission_key = p.permission_key AND g.scope_kind = 'global')
                 ELSE app.authorization_allowed(actor_id, p.permission_key, requested_client)
             END
       ) THEN
        RETURN false;
    END IF;
    INSERT INTO app.user_roles (id, user_id, role_id, scope_kind, client_id, assigned_at)
    VALUES (assignment_id, target_id, requested_role, requested_scope, requested_client, assigned_time);
    RETURN true;
EXCEPTION WHEN unique_violation OR foreign_key_violation OR check_violation THEN
    RETURN false;
END;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION app.revoke_role_assignment(actor_id uuid, assignment_id uuid, revoked_time timestamptz)
RETURNS TABLE(changed boolean, client_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE assignment app.user_roles%ROWTYPE;
BEGIN
    PERFORM pg_advisory_xact_lock(871092650209);
    SELECT * INTO assignment FROM app.user_roles WHERE id = assignment_id AND revoked_at IS NULL FOR UPDATE;
    IF NOT FOUND OR NOT app.authorization_allowed(actor_id, 'roles.manage', NULL) OR EXISTS (
        SELECT 1 FROM app.role_permissions rp JOIN app.permissions p ON p.permission_key = rp.permission_key
        WHERE rp.role_id = assignment.role_id AND rp.revoked_at IS NULL AND (assignment.scope_kind = 'global' OR p.scope_kind = 'client')
          AND NOT CASE
              WHEN assignment.scope_kind = 'global' THEN EXISTS (
                  SELECT 1 FROM app.authorization_grants(actor_id) g
                  WHERE g.permission_key = p.permission_key AND g.scope_kind = 'global')
              ELSE app.authorization_allowed(actor_id, p.permission_key, assignment.client_id)
          END
    ) THEN
        RETURN QUERY SELECT false, NULL::uuid;
        RETURN;
    END IF;
    UPDATE app.user_roles SET revoked_at = revoked_time WHERE id = assignment_id;
    RETURN QUERY SELECT true, assignment.client_id;
END;
$$;
-- +goose StatementEnd

-- Changing a role affects every current and future holder, so permission
-- delegation requires the actor to control that permission globally.
-- +goose StatementBegin
CREATE FUNCTION app.create_permission_assignment(
    actor_id uuid, requested_role uuid, requested_permission text,
    assignment_id uuid, assigned_time timestamptz)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(871092650209);
    IF assignment_id IS NULL OR assignment_id = '00000000-0000-0000-0000-000000000000' OR
       NOT app.authorization_allowed(actor_id, 'roles.manage', NULL) OR
       NOT EXISTS (SELECT 1 FROM app.roles WHERE id = requested_role) OR
       NOT EXISTS (SELECT 1 FROM app.permissions WHERE permission_key = requested_permission) OR
       NOT EXISTS (
           SELECT 1 FROM app.authorization_grants(actor_id) g
           WHERE g.permission_key = requested_permission AND g.scope_kind = 'global'
       ) THEN
        RETURN false;
    END IF;
    INSERT INTO app.role_permissions (id, role_id, permission_key, assigned_at)
    VALUES (assignment_id, requested_role, requested_permission, assigned_time);
    RETURN true;
EXCEPTION WHEN unique_violation OR foreign_key_violation OR check_violation THEN
    RETURN false;
END;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION app.revoke_permission_assignment(actor_id uuid, assignment_id uuid, revoked_time timestamptz)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE assignment app.role_permissions%ROWTYPE;
BEGIN
    PERFORM pg_advisory_xact_lock(871092650209);
    SELECT * INTO assignment FROM app.role_permissions WHERE id = assignment_id AND revoked_at IS NULL FOR UPDATE;
    IF NOT FOUND OR NOT app.authorization_allowed(actor_id, 'roles.manage', NULL) OR
       NOT EXISTS (
           SELECT 1 FROM app.authorization_grants(actor_id) g
           WHERE g.permission_key = assignment.permission_key AND g.scope_kind = 'global'
       ) THEN
        RETURN false;
    END IF;
    UPDATE app.role_permissions SET revoked_at = revoked_time WHERE id = assignment_id;
    RETURN true;
END;
$$;
-- +goose StatementEnd

REVOKE ALL ON TABLE app.permissions, app.roles, app.role_permissions, app.user_roles FROM PUBLIC;
REVOKE ALL ON FUNCTION app.authorization_grants(uuid),
                       app.authorization_allowed(uuid,text,uuid),
                       app.create_role_assignment(uuid,uuid,uuid,text,uuid,uuid,timestamptz),
                       app.revoke_role_assignment(uuid,uuid,timestamptz),
                       app.create_permission_assignment(uuid,uuid,text,uuid,timestamptz),
                       app.revoke_permission_assignment(uuid,uuid,timestamptz)
FROM PUBLIC;

-- +goose Down
LOCK TABLE app.user_roles IN ACCESS EXCLUSIVE MODE;
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM app.user_roles) OR
       EXISTS (SELECT 1 FROM app.role_permissions WHERE NOT seeded OR revoked_at IS NOT NULL) OR
       EXISTS (SELECT 1 FROM app.roles WHERE NOT system_role) THEN
        RAISE EXCEPTION 'Rollback refused: authorization history is not empty';
    END IF;
END;
$$;
-- +goose StatementEnd
DROP FUNCTION app.revoke_role_assignment(uuid,uuid,timestamptz);
DROP FUNCTION app.create_role_assignment(uuid,uuid,uuid,text,uuid,uuid,timestamptz);
DROP FUNCTION app.revoke_permission_assignment(uuid,uuid,timestamptz);
DROP FUNCTION app.create_permission_assignment(uuid,uuid,text,uuid,timestamptz);
DROP FUNCTION app.authorization_allowed(uuid,text,uuid);
DROP FUNCTION app.authorization_grants(uuid);
DROP TABLE app.user_roles;
DROP TABLE app.role_permissions;
DROP TABLE app.roles;
DROP TABLE app.permissions;
