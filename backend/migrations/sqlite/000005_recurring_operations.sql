-- Calendar templates produce existing task instances; history is never rewritten.
CREATE TABLE recurring_tasks (
 id TEXT PRIMARY KEY,client_id TEXT NOT NULL REFERENCES clients(id),created_by TEXT NOT NULL REFERENCES users(id),
 managed_by TEXT NOT NULL REFERENCES users(id),current_version INTEGER NOT NULL DEFAULT 1 CHECK(current_version>0),
 next_date TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','paused','cancelled','expired')),
 generated_count INTEGER NOT NULL DEFAULT 0 CHECK(generated_count>=0),revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 command_id TEXT NOT NULL,command_hash TEXT NOT NULL CHECK(length(command_hash)=64),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 UNIQUE(id,client_id),UNIQUE(client_id,command_id),
 FOREIGN KEY(id,current_version) REFERENCES recurring_task_versions(template_id,number) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX recurring_brand ON recurring_tasks(client_id,status,id);
CREATE INDEX recurring_schedule ON recurring_tasks(next_date,id) WHERE status='active';
CREATE TABLE recurring_task_versions (
 id TEXT PRIMARY KEY,template_id TEXT NOT NULL,client_id TEXT NOT NULL,number INTEGER NOT NULL CHECK(number>0),
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),description TEXT NOT NULL DEFAULT '',
 priority TEXT NOT NULL CHECK(priority IN ('low','medium','high','urgent')),website_id TEXT,
 assignee_id TEXT NOT NULL REFERENCES users(id),supervisor_id TEXT REFERENCES users(id),
 start_date TEXT NOT NULL,end_date TEXT,frequency TEXT NOT NULL CHECK(frequency IN ('daily','weekly','monthly')),
 interval INTEGER NOT NULL CHECK(interval BETWEEN 1 AND 365),anchor_day INTEGER NOT NULL CHECK(anchor_day BETWEEN 1 AND 31),
 due_time TEXT NOT NULL,timezone TEXT NOT NULL,occurrence_limit INTEGER CHECK(occurrence_limit BETWEEN 1 AND 100000),
 created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,
 FOREIGN KEY(template_id,client_id) REFERENCES recurring_tasks(id,client_id),
 FOREIGN KEY(website_id,client_id) REFERENCES client_websites(id,client_id),
 UNIQUE(template_id,number),UNIQUE(id,template_id,client_id),CHECK(end_date IS NULL OR end_date>=start_date)
) STRICT;
CREATE TABLE recurring_task_occurrences (
 id TEXT PRIMARY KEY,template_id TEXT NOT NULL,client_id TEXT NOT NULL,version_id TEXT NOT NULL,
 task_id TEXT NOT NULL UNIQUE,scheduled_date TEXT NOT NULL,created_at TEXT NOT NULL,
 FOREIGN KEY(template_id,client_id) REFERENCES recurring_tasks(id,client_id),
 FOREIGN KEY(version_id,template_id,client_id) REFERENCES recurring_task_versions(id,template_id,client_id),
 FOREIGN KEY(task_id,client_id) REFERENCES tasks(id,client_id),UNIQUE(template_id,scheduled_date)
) STRICT;
CREATE INDEX occurrence_brand ON recurring_task_occurrences(client_id,template_id,id);
CREATE TABLE recurring_task_commands (
 template_id TEXT NOT NULL REFERENCES recurring_tasks(id),command_id TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES users(id),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),created_at TEXT NOT NULL,PRIMARY KEY(template_id,command_id)
) STRICT;
CREATE TABLE notification_preferences (
 user_id TEXT PRIMARY KEY REFERENCES users(id),workflow INTEGER NOT NULL DEFAULT 1 CHECK(workflow IN (0,1)),
 tasks INTEGER NOT NULL DEFAULT 1 CHECK(tasks IN (0,1)),finance INTEGER NOT NULL DEFAULT 1 CHECK(finance IN (0,1)),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),updated_at TEXT NOT NULL
) STRICT;
-- Retry/backoff records contain fixed error codes, never raw exception or business text.
CREATE TABLE automation_failures (
 kind TEXT NOT NULL CHECK(kind IN ('task','agreement')),resource_id TEXT NOT NULL,client_id TEXT NOT NULL REFERENCES clients(id),
 error_code TEXT NOT NULL,failed_at TEXT NOT NULL,retry_after TEXT NOT NULL,
 PRIMARY KEY(kind,resource_id)
) STRICT;
CREATE TRIGGER recurring_identity BEFORE UPDATE ON recurring_tasks WHEN NEW.id<>OLD.id OR NEW.client_id<>OLD.client_id OR NEW.created_by<>OLD.created_by OR NEW.command_id<>OLD.command_id OR NEW.command_hash<>OLD.command_hash OR NEW.created_at<>OLD.created_at BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER recurring_no_delete BEFORE DELETE ON recurring_tasks BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER recurring_versions_no_update BEFORE UPDATE ON recurring_task_versions BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER recurring_versions_no_delete BEFORE DELETE ON recurring_task_versions BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER occurrences_no_update BEFORE UPDATE ON recurring_task_occurrences BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER occurrences_no_delete BEFORE DELETE ON recurring_task_occurrences BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER recurring_commands_no_update BEFORE UPDATE ON recurring_task_commands BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER recurring_commands_no_delete BEFORE DELETE ON recurring_task_commands BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TABLE automation_alerts (
 event_key TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),period_id TEXT REFERENCES billing_periods(id),created_at TEXT NOT NULL,
 CHECK((task_id IS NOT NULL)+(period_id IS NOT NULL)=1)
) STRICT;
CREATE TRIGGER automation_alerts_no_update BEFORE UPDATE ON automation_alerts BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER automation_alerts_no_delete BEFORE DELETE ON automation_alerts BEGIN SELECT RAISE(ABORT,'retained'); END;
