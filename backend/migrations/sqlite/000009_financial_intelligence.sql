-- Additive reporting indexes and independent retained operating payables.
CREATE INDEX finance_collections_currency ON collections(currency,client_id,id);
CREATE INDEX finance_payments_client_date ON payments(client_id,paid_on DESC,id);
CREATE INDEX finance_payments_activity ON payments(currency,paid_on,id);
CREATE INDEX finance_reversals_activity ON payment_reversals(currency,reversed_on,id);
CREATE INDEX finance_settlements_activity ON internal_settlements(currency,settled_on,id);
CREATE TABLE expense_categories (
 id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE CHECK(length(trim(name)) BETWEEN 1 AND 100),
 created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL
) STRICT;
CREATE TABLE expenses (
 id TEXT PRIMARY KEY,client_id TEXT REFERENCES clients(id),category_id TEXT NOT NULL REFERENCES expense_categories(id),
 title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),vendor TEXT NOT NULL CHECK(length(vendor)<=200),description TEXT NOT NULL CHECK(length(description)<=4000),
 currency TEXT NOT NULL REFERENCES billing_currencies(code),amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
 paid_minor INTEGER NOT NULL DEFAULT 0 CHECK(paid_minor BETWEEN 0 AND amount_minor),expense_date TEXT NOT NULL,due_date TEXT,
 created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 command_id TEXT NOT NULL UNIQUE,payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),cancelled_at TEXT
) STRICT;
CREATE INDEX expenses_currency ON expenses(currency,client_id,id);
CREATE INDEX expenses_due ON expenses(due_date,id) WHERE cancelled_at IS NULL AND paid_minor<amount_minor;
CREATE TABLE expense_events (
 id TEXT PRIMARY KEY,expense_id TEXT NOT NULL REFERENCES expenses(id),payment_id TEXT REFERENCES expense_events(id),
 kind TEXT NOT NULL CHECK(kind IN ('payment','reversal')),amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
 occurred_on TEXT NOT NULL,method TEXT NOT NULL CHECK(method IN ('bank_transfer','cash','card','other')),reason TEXT NOT NULL CHECK(length(reason)<=2000),
 recorded_by TEXT NOT NULL REFERENCES users(id),recorded_at TEXT NOT NULL,command_id TEXT NOT NULL UNIQUE,payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
 expected_revision INTEGER NOT NULL CHECK(expected_revision>0),CHECK((kind='payment' AND payment_id IS NULL) OR (kind='reversal' AND payment_id IS NOT NULL AND length(trim(reason))>0)),
 UNIQUE(expense_id,expected_revision)
) STRICT;
CREATE INDEX expense_events_parent ON expense_events(expense_id,id);
CREATE INDEX expense_events_reversal ON expense_events(payment_id,id);
CREATE INDEX expense_events_activity ON expense_events(occurred_on,id);
CREATE TABLE expense_commands (
 command_id TEXT PRIMARY KEY,expense_id TEXT NOT NULL REFERENCES expenses(id),actor_id TEXT NOT NULL REFERENCES users(id),payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),created_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER expense_event_valid BEFORE INSERT ON expense_events WHEN
 NOT EXISTS(SELECT 1 FROM expenses e WHERE e.id=NEW.expense_id AND e.cancelled_at IS NULL AND e.revision=NEW.expected_revision) OR
 (NEW.kind='payment' AND NEW.amount_minor>(SELECT amount_minor-paid_minor FROM expenses WHERE id=NEW.expense_id)) OR
 (NEW.kind='reversal' AND NOT EXISTS(SELECT 1 FROM expense_events p WHERE p.id=NEW.payment_id AND p.kind='payment' AND p.expense_id=NEW.expense_id AND p.method=NEW.method AND NEW.occurred_on>=p.occurred_on AND NEW.amount_minor<=p.amount_minor-CAST(coalesce((SELECT exact_sum(r.amount_minor) FROM expense_events r WHERE r.payment_id=p.id),'0') AS INTEGER)))
 BEGIN SELECT RAISE(ABORT,'invalid expense event'); END;
CREATE TRIGGER expense_ledger BEFORE UPDATE OF paid_minor ON expenses WHEN NEW.paid_minor<>CAST(coalesce((SELECT exact_sum(CASE kind WHEN 'payment' THEN amount_minor ELSE -amount_minor END) FROM expense_events WHERE expense_id=NEW.id),'0') AS INTEGER)
 BEGIN SELECT RAISE(ABORT,'invalid expense ledger'); END;
CREATE TRIGGER expense_event_apply AFTER INSERT ON expense_events BEGIN
 UPDATE expenses SET paid_minor=paid_minor+CASE NEW.kind WHEN 'payment' THEN NEW.amount_minor ELSE -NEW.amount_minor END,revision=revision+1 WHERE id=NEW.expense_id;
END;
CREATE TRIGGER expense_identity BEFORE UPDATE ON expenses WHEN NEW.id<>OLD.id OR NEW.client_id IS NOT OLD.client_id OR NEW.category_id<>OLD.category_id OR NEW.title<>OLD.title OR NEW.vendor<>OLD.vendor OR NEW.description<>OLD.description OR NEW.currency<>OLD.currency OR NEW.amount_minor<>OLD.amount_minor OR NEW.expense_date<>OLD.expense_date OR NEW.due_date IS NOT OLD.due_date OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at OR NEW.command_id<>OLD.command_id OR NEW.payload_hash<>OLD.payload_hash OR OLD.cancelled_at IS NOT NULL OR (NEW.cancelled_at IS NOT NULL AND EXISTS(SELECT 1 FROM expense_events WHERE expense_id=OLD.id))
 BEGIN SELECT RAISE(ABORT,'retained expense'); END;
CREATE TRIGGER expenses_no_delete BEFORE DELETE ON expenses BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER expense_events_no_update BEFORE UPDATE ON expense_events BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER expense_events_no_delete BEFORE DELETE ON expense_events BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER expense_categories_no_update BEFORE UPDATE ON expense_categories BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER expense_categories_no_delete BEFORE DELETE ON expense_categories BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER expense_commands_no_update BEFORE UPDATE ON expense_commands BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER expense_commands_no_delete BEFORE DELETE ON expense_commands BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER expense_revision BEFORE UPDATE ON expenses WHEN NEW.revision<>OLD.revision+1 BEGIN SELECT RAISE(ABORT,'invalid expense revision'); END;
