-- Relational durable state. Instants are canonical UTC strings with six fractional digits.
-- API services own authorization and audit within the same IMMEDIATE transaction.
CREATE TABLE users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
 password_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','disabled')),
 bootstrap_admin INTEGER NOT NULL DEFAULT 0 CHECK(bootstrap_admin IN (0,1)),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), last_login_at TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL CHECK(updated_at>=created_at)
) STRICT;
CREATE UNIQUE INDEX users_single_bootstrap_admin ON users(bootstrap_admin) WHERE bootstrap_admin=1;
CREATE TABLE sessions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 token_hash BLOB NOT NULL UNIQUE CHECK(length(token_hash)=32),
 csrf_hash BLOB NOT NULL CHECK(length(csrf_hash)=32),
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK(expires_at>created_at),
 revoked_at TEXT CHECK(revoked_at IS NULL OR revoked_at>=created_at)
) STRICT;
CREATE INDEX sessions_active_user ON sessions(user_id,expires_at) WHERE revoked_at IS NULL;
CREATE TABLE permissions (
 permission_key TEXT PRIMARY KEY, scope_kind TEXT NOT NULL CHECK(scope_kind IN ('global','client')),
 description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 160)
) STRICT;
CREATE TABLE roles (
 id TEXT PRIMARY KEY, role_key TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
 system_role INTEGER NOT NULL DEFAULT 0 CHECK(system_role IN (0,1)),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE role_permissions (
 id TEXT PRIMARY KEY, role_id TEXT NOT NULL REFERENCES roles(id),
 permission_key TEXT NOT NULL REFERENCES permissions(permission_key),
 seeded INTEGER NOT NULL DEFAULT 0 CHECK(seeded IN (0,1)), assigned_at TEXT NOT NULL, revoked_at TEXT
) STRICT;
CREATE UNIQUE INDEX role_permissions_active ON role_permissions(role_id,permission_key) WHERE revoked_at IS NULL;
CREATE TABLE client_scopes (id TEXT PRIMARY KEY) STRICT;
CREATE TABLE user_roles (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), role_id TEXT NOT NULL REFERENCES roles(id),
 scope_kind TEXT NOT NULL CHECK(scope_kind IN ('global','client')), client_id TEXT REFERENCES client_scopes(id),
 assigned_at TEXT NOT NULL, revoked_at TEXT,
 CHECK((scope_kind='global' AND client_id IS NULL) OR (scope_kind='client' AND client_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX user_roles_active_global ON user_roles(user_id,role_id) WHERE scope_kind='global' AND revoked_at IS NULL;
CREATE UNIQUE INDEX user_roles_active_client ON user_roles(user_id,role_id,client_id) WHERE scope_kind='client' AND revoked_at IS NULL;
CREATE INDEX user_roles_grants ON user_roles(user_id,scope_kind,client_id,role_id) WHERE revoked_at IS NULL;
CREATE TABLE audit_events (
 id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version=1),
 actor_kind TEXT NOT NULL CHECK(actor_kind IN ('user','system')), actor_user_id TEXT,
 event_name TEXT NOT NULL, resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL,
 client_id TEXT, request_id TEXT NOT NULL CHECK(length(request_id)=26),
 before_state TEXT NOT NULL CHECK(json_valid(before_state) AND length(before_state)<=1024),
 after_state TEXT NOT NULL CHECK(json_valid(after_state) AND length(after_state)<=1024),
 metadata TEXT NOT NULL CHECK(json_valid(metadata) AND json_type(metadata)='object' AND length(metadata)<=256),
 CHECK((actor_kind='user' AND actor_user_id IS NOT NULL) OR (actor_kind='system' AND actor_user_id IS NULL)),
 CHECK(request_id NOT GLOB '*[^A-Z2-7]*'),
 CHECK(length(resource_kind) BETWEEN 1 AND 32 AND resource_kind NOT GLOB '*[^a-z0-9_]*'),
 CHECK(event_name IN (resource_kind||'.created',resource_kind||'.updated',resource_kind||'.archived',resource_kind||'.deleted')
    OR (resource_kind='user' AND event_name='user.disabled') OR (resource_kind='role' AND event_name='role.permission_changed')
    OR (resource_kind='task' AND event_name IN ('task.completed','task.cancelled'))
    OR (resource_kind='reminder' AND event_name IN ('reminder.completed','reminder.dismissed'))
    OR (resource_kind='billing' AND event_name IN ('billing.cancelled','billing.payment_recorded'))),
 CHECK(audit_payload_valid(resource_kind,before_state,after_state,metadata))
) STRICT;
CREATE INDEX audit_global_cursor ON audit_events(occurred_at DESC,id DESC);
CREATE INDEX audit_client_cursor ON audit_events(client_id,occurred_at DESC,id DESC);
CREATE INDEX audit_resource ON audit_events(resource_kind,resource_id,occurred_at DESC,id DESC);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TABLE clients (
 id TEXT PRIMARY KEY REFERENCES client_scopes(id), name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 legal_name TEXT NOT NULL DEFAULT '', website TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 archived_at TEXT, CHECK(updated_at>=created_at)
) STRICT;
CREATE INDEX clients_archive_cursor ON clients(archived_at,id);
CREATE INDEX clients_name ON clients(name COLLATE NOCASE,id);
CREATE TABLE client_contacts (
 client_id TEXT NOT NULL REFERENCES clients(id), position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 19),
 name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', PRIMARY KEY(client_id,position)
) STRICT;
CREATE TABLE client_tags (
 client_id TEXT NOT NULL REFERENCES clients(id), tag TEXT NOT NULL CHECK(length(tag) BETWEEN 1 AND 40),
 PRIMARY KEY(client_id,tag)
) STRICT;
CREATE INDEX client_tags_filter ON client_tags(tag,client_id);
CREATE TABLE tasks (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), created_by TEXT NOT NULL REFERENCES users(id),
 assignee_id TEXT REFERENCES users(id), title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL CHECK(status IN ('backlog','todo','in_progress','blocked','review','done','cancelled')),
 priority TEXT NOT NULL CHECK(priority IN ('low','medium','high','urgent')),
 start_at TEXT, due_at TEXT, completed_at TEXT, cancelled_at TEXT,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT,
 UNIQUE(id,client_id), CHECK(start_at IS NULL OR due_at IS NULL OR due_at>=start_at),
 CHECK((status='done')=(completed_at IS NOT NULL)), CHECK((status='cancelled')=(cancelled_at IS NOT NULL))
) STRICT;
CREATE INDEX tasks_client_cursor ON tasks(client_id,id);
CREATE INDEX tasks_attention ON tasks(client_id,status,due_at,id) WHERE archived_at IS NULL;
CREATE TABLE task_tags (task_id TEXT NOT NULL REFERENCES tasks(id),tag TEXT NOT NULL,PRIMARY KEY(task_id,tag)) STRICT;
CREATE TABLE plans (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), created_by TEXT NOT NULL REFERENCES users(id),
 title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK(status IN ('draft','active','completed','cancelled')),
 start_at TEXT, due_at TEXT, completed_at TEXT, cancelled_at TEXT, revision INTEGER NOT NULL CHECK(revision>0),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT,
 UNIQUE(id,client_id), CHECK(start_at IS NULL OR due_at IS NULL OR due_at>=start_at),
 CHECK((status='completed')=(completed_at IS NOT NULL)), CHECK((status='cancelled')=(cancelled_at IS NOT NULL))
) STRICT;
CREATE INDEX plans_client_cursor ON plans(client_id,id);
CREATE TABLE milestones (
 id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, client_id TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id),
 title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK(status IN ('planned','in_progress','completed','cancelled')),
 due_at TEXT, completed_at TEXT, cancelled_at TEXT, revision INTEGER NOT NULL CHECK(revision>0),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT,
 UNIQUE(id,plan_id,client_id), FOREIGN KEY(plan_id,client_id) REFERENCES plans(id,client_id),
 CHECK((status='completed')=(completed_at IS NOT NULL)), CHECK((status='cancelled')=(cancelled_at IS NOT NULL))
) STRICT;
CREATE INDEX milestones_parent_cursor ON milestones(plan_id,client_id,id);
CREATE TABLE milestone_task_links (
 id TEXT PRIMARY KEY, milestone_id TEXT NOT NULL, plan_id TEXT NOT NULL, client_id TEXT NOT NULL,
 task_id TEXT NOT NULL, linked_at TEXT NOT NULL, unlinked_at TEXT,
 FOREIGN KEY(milestone_id,plan_id,client_id) REFERENCES milestones(id,plan_id,client_id),
 FOREIGN KEY(task_id,client_id) REFERENCES tasks(id,client_id)
) STRICT;
CREATE UNIQUE INDEX milestone_links_active ON milestone_task_links(milestone_id,task_id) WHERE unlinked_at IS NULL;
CREATE INDEX milestone_links_cursor ON milestone_task_links(milestone_id,id);
CREATE TABLE reminders (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), created_by TEXT NOT NULL REFERENCES users(id),
 owner_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL CHECK(status IN ('pending','completed','dismissed')),
 scheduled_at TEXT NOT NULL, scheduled_local TEXT NOT NULL, timezone TEXT NOT NULL,
 utc_offset_seconds INTEGER NOT NULL CHECK(utc_offset_seconds BETWEEN -86399 AND 86399),
 task_id TEXT, plan_id TEXT, milestone_id TEXT, milestone_plan_id TEXT, completed_at TEXT, dismissed_at TEXT,
 revision INTEGER NOT NULL CHECK(revision>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 FOREIGN KEY(task_id,client_id) REFERENCES tasks(id,client_id), FOREIGN KEY(plan_id,client_id) REFERENCES plans(id,client_id),
 FOREIGN KEY(milestone_id,milestone_plan_id,client_id) REFERENCES milestones(id,plan_id,client_id),
 CHECK((task_id IS NOT NULL)+(plan_id IS NOT NULL)+(milestone_id IS NOT NULL)<=1),
 CHECK((milestone_id IS NULL)=(milestone_plan_id IS NULL)),
 CHECK((status='completed')=(completed_at IS NOT NULL)), CHECK((status='dismissed')=(dismissed_at IS NOT NULL))
) STRICT;
CREATE INDEX reminders_client_cursor ON reminders(client_id,id);
CREATE INDEX reminders_due ON reminders(client_id,status,scheduled_at,id);
CREATE TABLE billing_currencies (
 code TEXT PRIMARY KEY CHECK(code IN ('USD','EUR','GBP','TRY','JPY','KWD')),
 exponent INTEGER NOT NULL CHECK(exponent=CASE code WHEN 'JPY' THEN 0 WHEN 'KWD' THEN 3 ELSE 2 END),
 UNIQUE(code,exponent)
) STRICT;
INSERT INTO billing_currencies VALUES ('EUR',2),('GBP',2),('JPY',0),('KWD',3),('TRY',2),('USD',2);
CREATE TABLE collections (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), created_by TEXT NOT NULL REFERENCES users(id),
 description TEXT NOT NULL, internal_note TEXT NOT NULL DEFAULT '', amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
 paid_minor INTEGER NOT NULL DEFAULT 0 CHECK(paid_minor>=0 AND paid_minor<=amount_minor),
 currency TEXT NOT NULL, currency_exponent INTEGER NOT NULL, due_date TEXT, cancelled_at TEXT,
 revision INTEGER NOT NULL CHECK(revision>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 FOREIGN KEY(currency,currency_exponent) REFERENCES billing_currencies(code,exponent),
 UNIQUE(id,client_id,currency), CHECK(cancelled_at IS NULL OR paid_minor<amount_minor)
) STRICT;
CREATE INDEX collections_client_cursor ON collections(client_id,id);
CREATE INDEX collections_due ON collections(client_id,due_date,id) WHERE cancelled_at IS NULL;
CREATE TABLE payments (
 id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, client_id TEXT NOT NULL, currency TEXT NOT NULL,
 recorded_by TEXT NOT NULL REFERENCES users(id), amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
 paid_on TEXT NOT NULL, method TEXT NOT NULL CHECK(method IN ('bank_transfer','cash','card','other')),
 reference TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', command_id TEXT NOT NULL,
 expected_revision INTEGER NOT NULL CHECK(expected_revision>0 AND expected_revision<9223372036854775807),
 collection_revision INTEGER NOT NULL CHECK(collection_revision=expected_revision+1), recorded_at TEXT NOT NULL,
 FOREIGN KEY(collection_id,client_id,currency) REFERENCES collections(id,client_id,currency),
 UNIQUE(collection_id,command_id), UNIQUE(collection_id,collection_revision)
) STRICT;
CREATE INDEX payments_collection_cursor ON payments(collection_id,id);
CREATE TRIGGER payments_balance BEFORE INSERT ON payments WHEN
 NEW.amount_minor>(SELECT amount_minor-paid_minor FROM collections WHERE id=NEW.collection_id)
 BEGIN SELECT RAISE(ABORT,'payment exceeds remaining balance'); END;
CREATE TRIGGER payments_apply AFTER INSERT ON payments BEGIN
 UPDATE collections SET paid_minor=paid_minor+NEW.amount_minor WHERE id=NEW.collection_id;
END;
CREATE TRIGGER collections_ledger BEFORE UPDATE OF paid_minor ON collections WHEN
 NEW.paid_minor<>coalesce((SELECT sum(amount_minor) FROM payments WHERE collection_id=NEW.id),0)
 BEGIN SELECT RAISE(ABORT,'balance must equal the retained ledger'); END;
CREATE TRIGGER payments_no_update BEFORE UPDATE ON payments BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER collections_no_delete BEFORE DELETE ON collections BEGIN SELECT RAISE(ABORT,'retained history'); END;
CREATE TRIGGER collections_identity BEFORE UPDATE ON collections WHEN NEW.id<>OLD.id OR NEW.client_id<>OLD.client_id
 OR NEW.created_by<>OLD.created_by OR NEW.currency<>OLD.currency OR NEW.currency_exponent<>OLD.currency_exponent
 OR NEW.created_at<>OLD.created_at BEGIN SELECT RAISE(ABORT,'immutable identity'); END;
CREATE TABLE pricing_sheets (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), currency TEXT NOT NULL,
 currency_exponent INTEGER NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 FOREIGN KEY(currency,currency_exponent) REFERENCES billing_currencies(code,exponent), UNIQUE(id,client_id,currency)
) STRICT;
CREATE TABLE pricing_versions (
 id TEXT PRIMARY KEY, sheet_id TEXT NOT NULL, client_id TEXT NOT NULL, currency TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), title TEXT NOT NULL, note TEXT NOT NULL, effective_from TEXT NOT NULL,
 effective_until TEXT CHECK(effective_until IS NULL OR effective_until>effective_from),
 created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 base_minor INTEGER NOT NULL CHECK(base_minor>=0), discount_minor INTEGER NOT NULL CHECK(discount_minor BETWEEN 0 AND base_minor),
 net_minor INTEGER NOT NULL CHECK(net_minor=base_minor-discount_minor), tax_minor INTEGER NOT NULL CHECK(tax_minor>=0),
 total_minor INTEGER NOT NULL CHECK(total_minor>=0 AND net_minor<=9223372036854775807-tax_minor AND total_minor=net_minor+tax_minor),
 cost_minor INTEGER CHECK(cost_minor IS NULL OR cost_minor>=0),
 creation_token TEXT NOT NULL DEFAULT(transaction_token()),
 FOREIGN KEY(sheet_id,client_id,currency) REFERENCES pricing_sheets(id,client_id,currency),
 UNIQUE(sheet_id,revision), UNIQUE(id,sheet_id,client_id,currency)
) STRICT;
CREATE INDEX pricing_versions_cursor ON pricing_versions(sheet_id,id);
CREATE INDEX pricing_versions_creation ON pricing_versions(creation_token);
CREATE TABLE pricing_lines (
 version_id TEXT NOT NULL REFERENCES pricing_versions(id), position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 50),
 description TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('recurring','one_time','custom')),
 frequency TEXT NOT NULL CHECK(frequency IN ('none','weekly','monthly','quarterly','yearly')),
 quantity_micros INTEGER NOT NULL CHECK(quantity_micros>0), unit_price_minor INTEGER NOT NULL CHECK(unit_price_minor>=0),
 discount_bps INTEGER NOT NULL CHECK(discount_bps BETWEEN 0 AND 10000), tax_bps INTEGER NOT NULL CHECK(tax_bps BETWEEN 0 AND 10000),
 unit_cost_minor INTEGER CHECK(unit_cost_minor IS NULL OR unit_cost_minor>=0),
 base_minor INTEGER NOT NULL CHECK(base_minor>=0), discount_minor INTEGER NOT NULL CHECK(discount_minor BETWEEN 0 AND base_minor),
 net_minor INTEGER NOT NULL CHECK(net_minor=base_minor-discount_minor), tax_minor INTEGER NOT NULL CHECK(tax_minor>=0),
 total_minor INTEGER NOT NULL CHECK(net_minor<=9223372036854775807-tax_minor AND total_minor=net_minor+tax_minor),
 cost_minor INTEGER CHECK(cost_minor IS NULL OR cost_minor>=0),
 CHECK((kind<>'recurring' OR frequency<>'none') AND (kind<>'one_time' OR frequency='none')), PRIMARY KEY(version_id,position)
) STRICT;
CREATE TABLE pricing_snapshots (
 collection_id TEXT PRIMARY KEY, client_id TEXT NOT NULL, sheet_id TEXT NOT NULL, version_id TEXT NOT NULL,
 currency TEXT NOT NULL, command_id TEXT NOT NULL, expected_revision INTEGER NOT NULL CHECK(expected_revision>0),
 created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, billing_date TEXT NOT NULL,
 original_due_date TEXT, original_internal_note TEXT NOT NULL, title TEXT NOT NULL,
 base_minor INTEGER NOT NULL, discount_minor INTEGER NOT NULL, net_minor INTEGER NOT NULL, tax_minor INTEGER NOT NULL,
 total_minor INTEGER NOT NULL CHECK(total_minor>0),
 creation_token TEXT NOT NULL DEFAULT(transaction_token()),
 FOREIGN KEY(collection_id,client_id,currency) REFERENCES collections(id,client_id,currency),
 FOREIGN KEY(version_id,sheet_id,client_id,currency) REFERENCES pricing_versions(id,sheet_id,client_id,currency), UNIQUE(client_id,command_id)
) STRICT;
CREATE TABLE pricing_snapshot_lines (
 collection_id TEXT NOT NULL REFERENCES pricing_snapshots(collection_id), position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 50),
 description TEXT NOT NULL, kind TEXT NOT NULL, frequency TEXT NOT NULL,
 quantity_micros INTEGER NOT NULL, unit_price_minor INTEGER NOT NULL, discount_bps INTEGER NOT NULL, tax_bps INTEGER NOT NULL,
 base_minor INTEGER NOT NULL, discount_minor INTEGER NOT NULL, net_minor INTEGER NOT NULL, tax_minor INTEGER NOT NULL, total_minor INTEGER NOT NULL,
 PRIMARY KEY(collection_id,position)
) STRICT;
CREATE INDEX pricing_snapshots_creation ON pricing_snapshots(creation_token);
CREATE TRIGGER pricing_lines_creation BEFORE INSERT ON pricing_lines WHEN
 (SELECT creation_token FROM pricing_versions WHERE id=NEW.version_id) IS NOT transaction_token()
 BEGIN SELECT RAISE(ABORT,'lines must belong to a new immutable version'); END;
CREATE TRIGGER pricing_snapshot_lines_creation BEFORE INSERT ON pricing_snapshot_lines WHEN
 (SELECT creation_token FROM pricing_snapshots WHERE collection_id=NEW.collection_id) IS NOT transaction_token()
 BEGIN SELECT RAISE(ABORT,'lines must belong to a new immutable snapshot'); END;
CREATE TRIGGER collections_amount BEFORE UPDATE OF amount_minor ON collections WHEN NEW.amount_minor<>OLD.amount_minor
 AND (EXISTS(SELECT 1 FROM payments WHERE collection_id=OLD.id) OR EXISTS(SELECT 1 FROM pricing_snapshots WHERE collection_id=OLD.id))
 BEGIN SELECT RAISE(ABORT,'immutable paid or copied amount'); END;
CREATE INDEX pricing_client_cursor ON pricing_sheets(client_id,id);
CREATE TABLE integration_connections (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), provider TEXT NOT NULL CHECK(provider IN ('meta_ads','ga4','woocommerce')),
 provider_account_id TEXT NOT NULL CHECK(integration_account_valid(provider,provider_account_id)), state TEXT NOT NULL CHECK(state IN ('pending','connected','disconnect_pending','revocation_failed','disconnected','reauthorization_required')),
 revision INTEGER NOT NULL CHECK(revision>0), generation INTEGER NOT NULL CHECK(generation>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(provider,provider_account_id), UNIQUE(id,client_id)
) STRICT;
CREATE INDEX integration_client_cursor ON integration_connections(client_id,id);
CREATE TRIGGER connection_identity BEFORE UPDATE ON integration_connections
 WHEN NEW.id<>OLD.id OR NEW.client_id<>OLD.client_id OR NEW.provider<>OLD.provider OR NEW.provider_account_id<>OLD.provider_account_id OR NEW.created_at<>OLD.created_at OR NEW.revision<>OLD.revision+1 OR NEW.generation<OLD.generation OR NEW.updated_at<OLD.updated_at
 BEGIN SELECT RAISE(ABORT,'immutable integration identity'); END;
CREATE TRIGGER connection_retention BEFORE DELETE ON integration_connections BEGIN SELECT RAISE(ABORT,'retained integration'); END;
CREATE TABLE integration_encryption_keys (
 id TEXT PRIMARY KEY, key_label TEXT NOT NULL UNIQUE CHECK(length(key_label) BETWEEN 1 AND 64 AND substr(key_label,1,1) GLOB '[a-z0-9]' AND key_label NOT GLOB '*[^a-z0-9_-]*'), fingerprint BLOB NOT NULL UNIQUE CHECK(length(fingerprint)=32 AND fingerprint<>zeroblob(32)),
 reservations INTEGER NOT NULL CHECK(reservations BETWEEN 0 AND 16777216), created_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER encryption_identity BEFORE UPDATE ON integration_encryption_keys
 WHEN NEW.id<>OLD.id OR NEW.key_label<>OLD.key_label OR NEW.fingerprint<>OLD.fingerprint OR NEW.created_at<>OLD.created_at OR NEW.reservations<>OLD.reservations+1
 BEGIN SELECT RAISE(ABORT,'immutable encryption accounting'); END;
CREATE TRIGGER encryption_retention BEFORE DELETE ON integration_encryption_keys BEGIN SELECT RAISE(ABORT,'retained encryption accounting'); END;
CREATE TABLE integration_credentials (
 connection_id TEXT PRIMARY KEY REFERENCES integration_connections(id), purpose TEXT NOT NULL CHECK(purpose IN ('access_token','provider_credential')),
 key_id TEXT NOT NULL REFERENCES integration_encryption_keys(id), envelope BLOB NOT NULL CHECK(length(envelope) BETWEEN 32 AND 16478),
 revision INTEGER NOT NULL CHECK(revision>0), generation INTEGER NOT NULL CHECK(generation>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX credential_keys ON integration_credentials(key_id,connection_id);
CREATE TRIGGER credential_identity BEFORE UPDATE ON integration_credentials
 WHEN NEW.connection_id<>OLD.connection_id OR NEW.purpose<>OLD.purpose OR NEW.created_at<>OLD.created_at OR NEW.revision<>OLD.revision+1 OR NEW.generation<OLD.generation OR NEW.updated_at<OLD.updated_at
 BEGIN SELECT RAISE(ABORT,'immutable credential identity'); END;
CREATE TRIGGER credential_retention BEFORE DELETE ON integration_credentials BEGIN SELECT RAISE(ABORT,'retained credential'); END;
CREATE TRIGGER credential_insert BEFORE INSERT ON integration_credentials
 WHEN NOT EXISTS(SELECT 1 FROM integration_encryption_keys k JOIN integration_connections c ON c.id=NEW.connection_id WHERE k.id=NEW.key_id AND k.reservations>0 AND NEW.purpose=CASE c.provider WHEN 'meta_ads' THEN 'access_token' ELSE 'provider_credential' END AND substr(NEW.envelope,1,1)=x'01' AND hex(substr(NEW.envelope,2,1))=printf('%02X',length(k.key_label)) AND substr(NEW.envelope,3,length(k.key_label))=CAST(k.key_label AS BLOB) AND length(NEW.envelope) BETWEEN 2+length(k.key_label)+29 AND 2+length(k.key_label)+28+16384)
 BEGIN SELECT RAISE(ABORT,'invalid credential envelope'); END;
CREATE TRIGGER credential_update BEFORE UPDATE ON integration_credentials
 WHEN NOT EXISTS(SELECT 1 FROM integration_encryption_keys k JOIN integration_connections c ON c.id=NEW.connection_id WHERE k.id=NEW.key_id AND k.reservations>0 AND NEW.purpose=CASE c.provider WHEN 'meta_ads' THEN 'access_token' ELSE 'provider_credential' END AND substr(NEW.envelope,1,1)=x'01' AND hex(substr(NEW.envelope,2,1))=printf('%02X',length(k.key_label)) AND substr(NEW.envelope,3,length(k.key_label))=CAST(k.key_label AS BLOB) AND length(NEW.envelope) BETWEEN 2+length(k.key_label)+29 AND 2+length(k.key_label)+28+16384)
 BEGIN SELECT RAISE(ABORT,'invalid credential envelope'); END;
CREATE TABLE analytics_sync_jobs (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), connection_id TEXT NOT NULL REFERENCES integration_connections(id),
 requested_by TEXT NOT NULL REFERENCES users(id), since TEXT, until TEXT,
 provider TEXT NOT NULL CHECK(provider IN ('ga4','meta_ads','woocommerce')), start_at TEXT, end_at TEXT, currency TEXT,
 connection_revision INTEGER NOT NULL CHECK(connection_revision>0), generation INTEGER NOT NULL CHECK(generation>0),
 credential_revision INTEGER NOT NULL CHECK(credential_revision>0), state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed')),
 reason TEXT CHECK(reason IN ('provider_unavailable','authorization_required','connection_changed','interrupted')),
 attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 3), lease_token TEXT, lease_until TEXT, revision INTEGER NOT NULL CHECK(revision>0),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT,
 CHECK(coalesce((provider IN ('ga4','meta_ads') AND since IS NOT NULL AND until IS NOT NULL AND since>='2000-01-01' AND date(since)=since AND date(until)=until AND until>=since AND julianday(until)-julianday(since)<=30 AND start_at IS NULL AND end_at IS NULL AND currency IS NULL) OR (provider='woocommerce' AND since IS NULL AND until IS NULL AND start_at>='2000-01-01T00:00:00.000000Z' AND length(start_at)=27 AND length(end_at)=27 AND substr(start_at,20)='.000000Z' AND substr(end_at,20)='.000000Z' AND end_at>start_at AND unixepoch(end_at)-unixepoch(start_at)<=2678400 AND currency IN ('USD','EUR','GBP','TRY','JPY','KWD')),0)),
 CHECK((state='running')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)), CHECK((lease_token IS NULL)=(lease_until IS NULL)),
 CHECK((state IN ('succeeded','failed'))=(finished_at IS NOT NULL)), CHECK((state='failed')=(reason IS NOT NULL)),
 FOREIGN KEY(connection_id,client_id) REFERENCES integration_connections(id,client_id)
) STRICT;
CREATE INDEX sync_claim ON analytics_sync_jobs(state,lease_until,created_at,id);
CREATE UNIQUE INDEX sync_one_active ON analytics_sync_jobs(connection_id) WHERE state IN ('queued','running');
CREATE INDEX sync_client_cursor ON analytics_sync_jobs(client_id,connection_id,id);
CREATE INDEX sync_latest_period ON analytics_sync_jobs(client_id,connection_id,generation,provider,since,until,start_at,end_at,currency,created_at DESC,id DESC);
CREATE TRIGGER sync_insert_binding BEFORE INSERT ON analytics_sync_jobs
 WHEN NOT EXISTS(SELECT 1 FROM integration_connections c WHERE c.id=NEW.connection_id AND c.client_id=NEW.client_id AND c.provider=NEW.provider)
 BEGIN SELECT RAISE(ABORT,'invalid job binding'); END;
CREATE TRIGGER sync_identity BEFORE UPDATE ON analytics_sync_jobs
 WHEN NEW.id IS NOT OLD.id OR NEW.client_id IS NOT OLD.client_id OR NEW.connection_id IS NOT OLD.connection_id OR NEW.requested_by IS NOT OLD.requested_by OR NEW.provider IS NOT OLD.provider OR NEW.since IS NOT OLD.since OR NEW.until IS NOT OLD.until OR NEW.start_at IS NOT OLD.start_at OR NEW.end_at IS NOT OLD.end_at OR NEW.currency IS NOT OLD.currency OR NEW.connection_revision IS NOT OLD.connection_revision OR NEW.generation IS NOT OLD.generation OR NEW.credential_revision IS NOT OLD.credential_revision OR NEW.created_at IS NOT OLD.created_at OR NEW.revision IS NOT OLD.revision+1 OR NEW.updated_at<OLD.updated_at OR OLD.state IN ('succeeded','failed') OR NEW.state='queued' OR NEW.attempts IS NOT OLD.attempts+CASE WHEN NEW.state='running' THEN 1 ELSE 0 END
 BEGIN SELECT RAISE(ABORT,'invalid job change'); END;
CREATE TRIGGER sync_retained BEFORE DELETE ON analytics_sync_jobs
 BEGIN SELECT RAISE(ABORT,'job history is retained'); END;
CREATE TABLE analytics_snapshots (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), connection_id TEXT NOT NULL REFERENCES integration_connections(id),
 generation INTEGER NOT NULL CHECK(generation>0), since TEXT, until TEXT,
 provider TEXT NOT NULL CHECK(provider IN ('ga4','meta_ads','woocommerce')), start_at TEXT, end_at TEXT, currency TEXT,
 workspace TEXT NOT NULL CHECK(json_valid(workspace) AND json_type(workspace)='object' AND length(workspace)<=2097152),
 workspace_sha256 TEXT NOT NULL CHECK(length(workspace_sha256)=64 AND workspace_sha256 NOT GLOB '*[^0-9a-f]*'),
 revision INTEGER NOT NULL CHECK(revision>0), synced_at TEXT NOT NULL,
 FOREIGN KEY(connection_id,client_id) REFERENCES integration_connections(id,client_id),
 CHECK(coalesce((provider IN ('ga4','meta_ads') AND since IS NOT NULL AND until IS NOT NULL AND since>='2000-01-01' AND date(since)=since AND date(until)=until AND until>=since AND julianday(until)-julianday(since)<=30 AND start_at IS NULL AND end_at IS NULL AND currency IS NULL) OR (provider='woocommerce' AND since IS NULL AND until IS NULL AND start_at>='2000-01-01T00:00:00.000000Z' AND length(start_at)=27 AND length(end_at)=27 AND substr(start_at,20)='.000000Z' AND substr(end_at,20)='.000000Z' AND end_at>start_at AND unixepoch(end_at)-unixepoch(start_at)<=2678400 AND currency IN ('USD','EUR','GBP','TRY','JPY','KWD')),0))
) STRICT;
CREATE UNIQUE INDEX snapshot_period ON analytics_snapshots(connection_id,generation,provider,coalesce(since,''),coalesce(until,''),coalesce(start_at,''),coalesce(end_at,''),coalesce(currency,''));
CREATE INDEX snapshot_retention ON analytics_snapshots(synced_at,id);
CREATE INDEX snapshot_client_period ON analytics_snapshots(client_id,connection_id,generation,provider,since,until,start_at,end_at,currency);
CREATE TRIGGER snapshot_insert_binding BEFORE INSERT ON analytics_snapshots
 WHEN NOT EXISTS(SELECT 1 FROM integration_connections c WHERE c.id=NEW.connection_id AND c.client_id=NEW.client_id AND c.provider=NEW.provider)
 BEGIN SELECT RAISE(ABORT,'invalid snapshot binding'); END;
CREATE TRIGGER snapshot_identity BEFORE UPDATE ON analytics_snapshots
 WHEN NEW.id IS NOT OLD.id OR NEW.client_id IS NOT OLD.client_id OR NEW.connection_id IS NOT OLD.connection_id OR NEW.provider IS NOT OLD.provider OR NEW.generation IS NOT OLD.generation OR NEW.since IS NOT OLD.since OR NEW.until IS NOT OLD.until OR NEW.start_at IS NOT OLD.start_at OR NEW.end_at IS NOT OLD.end_at OR NEW.currency IS NOT OLD.currency OR NEW.revision IS NOT OLD.revision+1 OR NEW.synced_at<OLD.synced_at
 BEGIN SELECT RAISE(ABORT,'invalid snapshot change'); END;
CREATE TABLE client_websites (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), name TEXT NOT NULL, url TEXT NOT NULL,
 domain TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', is_primary INTEGER NOT NULL CHECK(is_primary IN (0,1)),
 needs_review INTEGER NOT NULL CHECK(needs_review IN (0,1)), legacy_source INTEGER NOT NULL CHECK(legacy_source IN (0,1)),
 revision INTEGER NOT NULL CHECK(revision>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT,
 UNIQUE(id,client_id), CHECK(NOT is_primary OR (archived_at IS NULL AND NOT needs_review))
) STRICT;
CREATE UNIQUE INDEX website_primary ON client_websites(client_id) WHERE is_primary=1;
CREATE UNIQUE INDEX website_legacy ON client_websites(client_id) WHERE legacy_source=1;
CREATE UNIQUE INDEX website_active_url ON client_websites(client_id,url) WHERE archived_at IS NULL AND needs_review=0;
CREATE INDEX websites_client_cursor ON client_websites(client_id,id);
CREATE TABLE website_integrations (
 connection_id TEXT PRIMARY KEY, website_id TEXT NOT NULL, client_id TEXT NOT NULL,
 FOREIGN KEY(website_id,client_id) REFERENCES client_websites(id,client_id),
 FOREIGN KEY(connection_id,client_id) REFERENCES integration_connections(id,client_id)
) STRICT;
CREATE TABLE user_locale_preferences (
 user_id TEXT PRIMARY KEY REFERENCES users(id), locale TEXT NOT NULL CHECK(locale IN ('en','tr','ro','de','fr')),
 revision INTEGER NOT NULL CHECK(revision>0)
) STRICT;
CREATE TABLE import_receipts (source TEXT PRIMARY KEY, imported_at TEXT NOT NULL, source_sha256 TEXT NOT NULL, row_counts TEXT NOT NULL) STRICT;
