-- Local Compose role provisioning after every migration up/down/up cycle.
-- Production operators must substitute their separately provisioned runtime role.
\set ON_ERROR_STOP on
GRANT USAGE ON SCHEMA app TO else_runtime;
GRANT INSERT (actor_kind, actor_user_id, event_name, resource_kind, resource_id,
              client_id, request_id, before_state, after_state, metadata)
ON app.audit_events TO else_runtime;
GRANT EXECUTE ON FUNCTION app.audit_snapshot_allowed(jsonb) TO else_runtime;

GRANT SELECT (id) ON app.users TO else_runtime;
GRANT UPDATE (last_login_at, updated_at) ON app.users TO else_runtime;
GRANT SELECT (id, expires_at, revoked_at) ON app.sessions TO else_runtime;
GRANT INSERT (id, user_id, token_hash, csrf_hash, created_at, expires_at)
ON app.sessions TO else_runtime;
GRANT UPDATE (revoked_at) ON app.sessions TO else_runtime;
GRANT EXECUTE ON FUNCTION app.authentication_identity(text),
                          app.lock_authentication_identity(uuid),
                          app.current_identity(bytea, timestamptz),
                          app.authorization_grants(uuid),
                          app.authorization_allowed(uuid, text, uuid),
                          app.create_role_assignment(uuid, uuid, uuid, text, uuid, uuid, timestamptz),
                          app.revoke_role_assignment(uuid, uuid, timestamptz),
                          app.create_permission_assignment(uuid, uuid, text, uuid, timestamptz),
                          app.revoke_permission_assignment(uuid, uuid, timestamptz)
TO else_runtime;

GRANT EXECUTE ON FUNCTION app.admin_users(uuid,uuid,integer),app.admin_user(uuid,uuid),
                          app.admin_roles(uuid,uuid,integer),app.admin_role(uuid,uuid),app.admin_catalog(uuid),
                          app.admin_assignments(uuid,uuid,uuid,integer),app.admin_create_user(uuid,uuid,text,text,text),
                          app.admin_update_user(uuid,uuid,bigint,text,text),app.admin_disable_user(uuid,uuid,bigint),
                          app.admin_create_role(uuid,uuid,text,text[]),app.admin_replace_permissions(uuid,uuid,bigint,text[]),
                          app.admin_revoke_assignment(uuid,uuid,uuid,timestamptz)
TO else_runtime;
