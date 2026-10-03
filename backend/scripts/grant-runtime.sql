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

GRANT EXECUTE ON FUNCTION app.client_read(uuid,uuid),app.client_list(uuid,uuid,integer,text,text,text,boolean),
 app.client_write(uuid,uuid,bigint,jsonb,boolean) TO else_runtime;

GRANT EXECUTE ON FUNCTION app.task_read(uuid,uuid,uuid),
 app.task_list(uuid,uuid,uuid,integer,text,text,uuid,boolean,text,text,text,boolean),
 app.task_assignees(uuid,uuid,uuid,integer),app.task_write(uuid,uuid,uuid,bigint,text,jsonb,text) TO else_runtime;

GRANT EXECUTE ON FUNCTION app.planning_read(uuid,uuid,uuid,uuid),
 app.planning_list(uuid,uuid,uuid,uuid,integer,text,text,text,boolean),
 app.planning_links(uuid,uuid,uuid,uuid,uuid,integer,text,boolean),
 app.planning_task_candidates(uuid,uuid,uuid,uuid,integer,text,boolean),
 app.planning_write(uuid,uuid,uuid,uuid,bigint,text,jsonb,text,jsonb) TO else_runtime;

GRANT EXECUTE ON FUNCTION app.reminder_read(uuid,uuid,uuid),
 app.reminder_list(uuid,uuid,uuid,integer,text,text,uuid,text,boolean),
 app.reminder_owners(uuid,uuid,uuid,integer),app.reminder_write(uuid,uuid,uuid,bigint,text,jsonb) TO else_runtime;

GRANT EXECUTE ON FUNCTION app.activity_list(uuid,uuid,timestamptz,uuid,integer) TO else_runtime;
GRANT EXECUTE ON FUNCTION app.client_overview(uuid,uuid) TO else_runtime;
GRANT EXECUTE ON FUNCTION app.integration_connection_list(uuid,uuid,uuid,integer),
 app.integration_connection_read(uuid,uuid,uuid) TO else_runtime;
GRANT EXECUTE ON FUNCTION app.pricing_read(uuid,uuid,uuid,uuid),app.pricing_list(uuid,uuid,uuid,uuid,integer),
 app.pricing_preview(uuid,uuid,jsonb),app.pricing_write(uuid,uuid,uuid,uuid,bigint,jsonb),
 app.pricing_copy(uuid,uuid,uuid,uuid,bigint,jsonb,uuid),app.pricing_snapshot_read(uuid,uuid,uuid) TO else_runtime;
GRANT EXECUTE ON FUNCTION app.billing_read(uuid,uuid,uuid),app.billing_list(uuid,uuid,uuid,integer,text,text,text),
 app.billing_payments(uuid,uuid,uuid,uuid,integer),app.billing_summary(uuid,uuid),app.billing_currency_list(uuid,uuid),
 app.billing_write(uuid,uuid,uuid,bigint,text,jsonb,uuid) TO else_runtime;
GRANT EXECUTE ON FUNCTION app.audit_reader_list(uuid,uuid,uuid,uuid,text,text,text,uuid,text,timestamptz,timestamptz,timestamptz,uuid,integer),
 app.audit_reader_detail(uuid,uuid,uuid) TO else_runtime;

GRANT EXECUTE ON FUNCTION app.admin_users(uuid,uuid,integer),app.admin_user(uuid,uuid),
                          app.admin_roles(uuid,uuid,integer),app.admin_role(uuid,uuid),app.admin_catalog(uuid),
                          app.admin_assignments(uuid,uuid,uuid,integer),app.admin_create_user(uuid,uuid,text,text,text),
                          app.admin_update_user(uuid,uuid,bigint,text,text),app.admin_disable_user(uuid,uuid,bigint),
                          app.admin_create_role(uuid,uuid,text,text[]),app.admin_replace_permissions(uuid,uuid,bigint,text[]),
                          app.admin_revoke_assignment(uuid,uuid,uuid,timestamptz)
TO else_runtime;
