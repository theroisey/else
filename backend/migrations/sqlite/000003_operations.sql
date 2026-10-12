-- Operational extensions; existing users, scopes, tasks and histories remain intact.
CREATE TABLE operation_settings (
 id INTEGER PRIMARY KEY CHECK(id=1), timezone TEXT NOT NULL DEFAULT 'Europe/Bucharest',
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), updated_at TEXT NOT NULL
) STRICT;
INSERT INTO operation_settings(id,updated_at) VALUES (1,strftime('%Y-%m-%dT%H:%M:%f000Z','now'));
CREATE TABLE teams (
 id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 leader_id TEXT NOT NULL REFERENCES users(id), revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
) STRICT;
CREATE INDEX teams_leader ON teams(leader_id,id) WHERE archived_at IS NULL;
CREATE TABLE team_memberships (
 id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), user_id TEXT NOT NULL REFERENCES users(id),
 assigned_at TEXT NOT NULL, revoked_at TEXT
) STRICT;
CREATE UNIQUE INDEX team_membership_active ON team_memberships(team_id,user_id) WHERE revoked_at IS NULL;
CREATE INDEX team_member_access ON team_memberships(user_id,team_id) WHERE revoked_at IS NULL;
CREATE TABLE brand_staff_assignments (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), user_id TEXT NOT NULL REFERENCES users(id),
 team_id TEXT NOT NULL REFERENCES teams(id), user_role_id TEXT NOT NULL REFERENCES user_roles(id), owns_role INTEGER NOT NULL DEFAULT 1 CHECK(owns_role IN (0,1)),
 responsibility TEXT NOT NULL DEFAULT '', assigned_by TEXT NOT NULL REFERENCES users(id), assigned_at TEXT NOT NULL, revoked_at TEXT
) STRICT;
CREATE UNIQUE INDEX brand_staff_active ON brand_staff_assignments(client_id,user_id) WHERE revoked_at IS NULL;
CREATE INDEX brand_staff_team ON brand_staff_assignments(team_id,client_id,user_id) WHERE revoked_at IS NULL;
CREATE TABLE technical_requests (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), website_id TEXT,
 created_by TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 8000),
 category TEXT NOT NULL CHECK(category IN ('bug','design','feature','content','performance','integration','support','other')),
 priority TEXT NOT NULL CHECK(priority IN ('normal','high','critical')), reference_url TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL CHECK(status IN ('new','accepted','rejected','in_progress','delivered','revision_requested','approved','cancelled')),
 assignee_id TEXT REFERENCES users(id), task_id TEXT UNIQUE, due_at TEXT,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), delivery_count INTEGER NOT NULL DEFAULT 0 CHECK(delivery_count>=0),
 command_id TEXT NOT NULL, command_hash TEXT NOT NULL CHECK(length(command_hash)=64),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 FOREIGN KEY(website_id,client_id) REFERENCES client_websites(id,client_id),
 FOREIGN KEY(task_id,client_id) REFERENCES tasks(id,client_id),
 UNIQUE(id,client_id), UNIQUE(client_id,command_id),
 CHECK(status NOT IN ('accepted','in_progress','delivered','revision_requested','approved') OR task_id IS NOT NULL),
 CHECK(status NOT IN ('in_progress','delivered','revision_requested','approved') OR assignee_id IS NOT NULL),
 CHECK(status NOT IN ('delivered','revision_requested','approved') OR delivery_count>0)
) STRICT;
CREATE INDEX request_brand_queue ON technical_requests(client_id,status,updated_at,id);
CREATE INDEX request_creator ON technical_requests(created_by,client_id,status,id);
CREATE INDEX request_assignee ON technical_requests(assignee_id,status,due_at,id);
CREATE TABLE request_deliveries (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES technical_requests(id),
 number INTEGER NOT NULL CHECK(number>0), delivered_by TEXT NOT NULL REFERENCES users(id),
 summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 8000), test_notes TEXT NOT NULL DEFAULT '',
 implementation_url TEXT NOT NULL DEFAULT '', reference TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
 UNIQUE(request_id,number), UNIQUE(id,request_id)
) STRICT;
CREATE TABLE delivery_reviews (
 id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL UNIQUE REFERENCES request_deliveries(id),
 reviewed_by TEXT NOT NULL REFERENCES users(id), decision TEXT NOT NULL CHECK(decision IN ('approved','revision_requested')),
 reason TEXT NOT NULL, created_at TEXT NOT NULL,
 CHECK(decision='approved' OR length(trim(reason))>0)
) STRICT;
CREATE TABLE request_events (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES technical_requests(id),
 sequence INTEGER NOT NULL CHECK(sequence>0), actor_id TEXT NOT NULL REFERENCES users(id),
 action TEXT NOT NULL CHECK(action IN ('created','accepted','rejected','assigned','started','delivered','approved','revision_requested','reopened','cancelled','commented')),
 status TEXT NOT NULL CHECK(status IN ('new','accepted','rejected','in_progress','delivered','revision_requested','approved','cancelled')),
 text TEXT NOT NULL DEFAULT '', delivery_id TEXT REFERENCES request_deliveries(id), created_at TEXT NOT NULL,
 UNIQUE(request_id,sequence)
) STRICT;
CREATE INDEX request_timeline ON request_events(request_id,sequence);
CREATE TABLE request_commands (
 request_id TEXT NOT NULL REFERENCES technical_requests(id), command_id TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES users(id), payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
 event_id TEXT NOT NULL UNIQUE REFERENCES request_events(id), PRIMARY KEY(request_id,command_id)
) STRICT;
CREATE TABLE request_evidence (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id),
 uploaded_by TEXT NOT NULL REFERENCES users(id), request_id TEXT, delivery_id TEXT,
 filename TEXT NOT NULL CHECK(length(filename) BETWEEN 1 AND 120),
 mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/webp','application/pdf')),
 size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 8388608), sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 content BLOB NOT NULL CHECK(length(content)=size), created_at TEXT NOT NULL,
 FOREIGN KEY(request_id,client_id) REFERENCES technical_requests(id,client_id),
 FOREIGN KEY(delivery_id,request_id) REFERENCES request_deliveries(id,request_id),
 CHECK(delivery_id IS NULL OR request_id IS NOT NULL)
) STRICT;
CREATE INDEX evidence_request ON request_evidence(request_id,delivery_id,id);
CREATE INDEX evidence_staged ON request_evidence(uploaded_by,created_at) WHERE request_id IS NULL;
CREATE TABLE notifications (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 client_id TEXT NOT NULL REFERENCES clients(id), request_id TEXT, task_id TEXT,
 period_id TEXT,agreement_id TEXT,template_id TEXT,
 event_key TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT,
 FOREIGN KEY(request_id,client_id) REFERENCES technical_requests(id,client_id),
 FOREIGN KEY(task_id,client_id) REFERENCES tasks(id,client_id),
 FOREIGN KEY(period_id,client_id) REFERENCES billing_periods(id,client_id),
 FOREIGN KEY(agreement_id,client_id) REFERENCES service_agreements(id,client_id),
 FOREIGN KEY(template_id,client_id) REFERENCES recurring_tasks(id,client_id),
 UNIQUE(user_id,event_key), CHECK((request_id IS NOT NULL)+(task_id IS NOT NULL)+(period_id IS NOT NULL)+(agreement_id IS NOT NULL)+(template_id IS NOT NULL)=1)
) STRICT;
CREATE INDEX notification_inbox ON notifications(user_id,id);
CREATE INDEX notification_unread ON notifications(user_id,client_id) WHERE read_at IS NULL;
-- General task writes cannot forge final approval of a technical delivery.
CREATE TRIGGER request_task_state BEFORE UPDATE OF status,assignee_id,archived_at ON tasks WHEN
 EXISTS(SELECT 1 FROM technical_requests r WHERE r.task_id=OLD.id AND
 (NEW.archived_at IS NOT OLD.archived_at OR NEW.assignee_id IS NOT r.assignee_id OR
 NEW.status<>CASE r.status WHEN 'accepted' THEN 'todo' WHEN 'in_progress' THEN 'in_progress'
 WHEN 'revision_requested' THEN 'in_progress' WHEN 'delivered' THEN 'review' WHEN 'approved' THEN 'done'
 WHEN 'cancelled' THEN 'cancelled' ELSE 'todo' END))
 BEGIN SELECT RAISE(ABORT,'technical workflow required'); END;
CREATE TRIGGER request_identity BEFORE UPDATE ON technical_requests WHEN
 NEW.id<>OLD.id OR NEW.client_id<>OLD.client_id OR NEW.website_id IS NOT OLD.website_id OR NEW.created_by<>OLD.created_by
 OR NEW.command_id<>OLD.command_id OR NEW.command_hash<>OLD.command_hash OR NEW.created_at<>OLD.created_at
 OR (OLD.task_id IS NOT NULL AND NEW.task_id IS NOT OLD.task_id)
 BEGIN SELECT RAISE(ABORT,'immutable request identity'); END;
CREATE TRIGGER request_no_delete BEFORE DELETE ON technical_requests BEGIN SELECT RAISE(ABORT,'retained request'); END;
CREATE TRIGGER request_events_no_update BEFORE UPDATE ON request_events BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER request_events_no_delete BEFORE DELETE ON request_events BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER deliveries_no_update BEFORE UPDATE ON request_deliveries BEGIN SELECT RAISE(ABORT,'immutable delivery'); END;
CREATE TRIGGER deliveries_no_delete BEFORE DELETE ON request_deliveries BEGIN SELECT RAISE(ABORT,'immutable delivery'); END;
CREATE TRIGGER reviews_no_update BEFORE UPDATE ON delivery_reviews BEGIN SELECT RAISE(ABORT,'immutable review'); END;
CREATE TRIGGER reviews_no_delete BEFORE DELETE ON delivery_reviews BEGIN SELECT RAISE(ABORT,'immutable review'); END;
CREATE TRIGGER request_commands_no_update BEFORE UPDATE ON request_commands BEGIN SELECT RAISE(ABORT,'immutable command'); END;
CREATE TRIGGER request_commands_no_delete BEFORE DELETE ON request_commands BEGIN SELECT RAISE(ABORT,'immutable command'); END;
CREATE TRIGGER evidence_history BEFORE UPDATE ON request_evidence WHEN OLD.request_id IS NOT NULL
 OR NEW.id<>OLD.id OR NEW.client_id<>OLD.client_id OR NEW.uploaded_by<>OLD.uploaded_by OR NEW.filename<>OLD.filename
 OR NEW.mime<>OLD.mime OR NEW.size<>OLD.size OR NEW.sha256<>OLD.sha256 OR NEW.content<>OLD.content OR NEW.created_at<>OLD.created_at
 BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;
CREATE TRIGGER evidence_retained BEFORE DELETE ON request_evidence WHEN OLD.request_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'retained evidence'); END;
CREATE INDEX notifications_chronological ON notifications(user_id,created_at DESC,id DESC);
CREATE INDEX tasks_assignee_attention ON tasks(assignee_id,due_at,id) WHERE archived_at IS NULL AND status NOT IN ('done','cancelled');

CREATE TRIGGER teams_retained BEFORE DELETE ON teams BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER memberships_retained BEFORE DELETE ON team_memberships BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER memberships_identity BEFORE UPDATE ON team_memberships WHEN NEW.id<>OLD.id OR NEW.team_id<>OLD.team_id OR NEW.user_id<>OLD.user_id OR NEW.assigned_at<>OLD.assigned_at OR OLD.revoked_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER assignments_retained BEFORE DELETE ON brand_staff_assignments BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER assignments_identity BEFORE UPDATE ON brand_staff_assignments WHEN NEW.id<>OLD.id OR NEW.client_id<>OLD.client_id OR NEW.user_id<>OLD.user_id OR NEW.team_id<>OLD.team_id OR NEW.user_role_id<>OLD.user_role_id OR NEW.owns_role<>OLD.owns_role OR NEW.responsibility<>OLD.responsibility OR NEW.assigned_by<>OLD.assigned_by OR NEW.assigned_at<>OLD.assigned_at OR OLD.revoked_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'retained'); END;

CREATE TABLE team_leadership_history (
 id TEXT PRIMARY KEY,team_id TEXT NOT NULL REFERENCES teams(id),previous_leader_id TEXT REFERENCES users(id),leader_id TEXT NOT NULL REFERENCES users(id),actor_id TEXT NOT NULL REFERENCES users(id),revision INTEGER NOT NULL CHECK(revision>0),created_at TEXT NOT NULL,
 UNIQUE(team_id,revision)
) STRICT;
CREATE INDEX team_leadership_timeline ON team_leadership_history(team_id,id);
CREATE TRIGGER team_leadership_retained_update BEFORE UPDATE ON team_leadership_history BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER team_leadership_retained_delete BEFORE DELETE ON team_leadership_history BEGIN SELECT RAISE(ABORT,'retained'); END;
