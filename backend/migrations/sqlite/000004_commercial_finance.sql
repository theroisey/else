-- Add commercial terms to the existing collection/payment ledger. No legacy
-- user, brand, payment, balance, currency, pricing term or timestamp is rewritten.
CREATE TABLE commercial_partners (
 id TEXT PRIMARY KEY,name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,archived_at TEXT,
 UNIQUE(name)
) STRICT;
CREATE TABLE service_agreements (
 id TEXT PRIMARY KEY,client_id TEXT NOT NULL REFERENCES clients(id),created_by TEXT NOT NULL REFERENCES users(id),
 managed_by TEXT NOT NULL REFERENCES users(id),
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),service_type TEXT NOT NULL CHECK(service_type IN ('software_maintenance','software_development','advertising_consulting','other')),
 frequency TEXT NOT NULL CHECK(frequency IN ('once','monthly')),start_date TEXT NOT NULL,end_date TEXT,
 due_offset_days INTEGER NOT NULL CHECK(due_offset_days BETWEEN 0 AND 90),timezone TEXT NOT NULL,
 anchor_day INTEGER NOT NULL CHECK(anchor_day BETWEEN 1 AND 31),next_date TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('active','paused','cancelled','expired')),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),command_id TEXT NOT NULL,command_hash TEXT NOT NULL CHECK(length(command_hash)=64),
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 UNIQUE(id,client_id),UNIQUE(client_id,command_id),CHECK(end_date IS NULL OR end_date>=start_date)
) STRICT;
CREATE INDEX agreements_brand ON service_agreements(client_id,status,id);
CREATE INDEX agreements_scheduler ON service_agreements(next_date,id) WHERE status='active';
CREATE TABLE agreement_versions (
 id TEXT PRIMARY KEY,agreement_id TEXT NOT NULL,client_id TEXT NOT NULL,number INTEGER NOT NULL CHECK(number>0),
 amount_minor INTEGER NOT NULL CHECK(amount_minor>0),currency TEXT NOT NULL REFERENCES billing_currencies(code),
 roise_share_minor INTEGER NOT NULL CHECK(roise_share_minor>=0 AND roise_share_minor<=amount_minor),
 partner_id TEXT REFERENCES commercial_partners(id),collector TEXT NOT NULL CHECK(collector IN ('roise','partner')),
 allocation_policy TEXT NOT NULL CHECK(allocation_policy IN ('proportional','contractual')),
 effective_from TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,
 FOREIGN KEY(agreement_id,client_id) REFERENCES service_agreements(id,client_id),
 UNIQUE(agreement_id,number),UNIQUE(agreement_id,effective_from),UNIQUE(id,agreement_id,client_id,currency),
 CHECK(partner_id IS NOT NULL OR (roise_share_minor=amount_minor AND collector='roise'))
) STRICT;
CREATE INDEX agreement_effective_terms ON agreement_versions(agreement_id,effective_from DESC);
CREATE TABLE billing_periods (
 id TEXT PRIMARY KEY,agreement_id TEXT NOT NULL,client_id TEXT NOT NULL,version_id TEXT NOT NULL,
 collection_id TEXT NOT NULL UNIQUE,currency TEXT NOT NULL,period_key TEXT NOT NULL,billing_date TEXT NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,
 voided_at TEXT,voided_by TEXT REFERENCES users(id),void_reason TEXT NOT NULL DEFAULT '',
 FOREIGN KEY(agreement_id,client_id) REFERENCES service_agreements(id,client_id),
 FOREIGN KEY(version_id,agreement_id,client_id,currency) REFERENCES agreement_versions(id,agreement_id,client_id,currency),
 FOREIGN KEY(collection_id,client_id,currency) REFERENCES collections(id,client_id,currency),
 UNIQUE(agreement_id,period_key),UNIQUE(id,client_id,currency),
 CHECK((voided_at IS NULL AND voided_by IS NULL AND void_reason='') OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND length(trim(void_reason))>0))
) STRICT;
CREATE UNIQUE INDEX billing_period_parent ON billing_periods(id,client_id);
CREATE INDEX commercial_periods ON billing_periods(client_id,billing_date DESC,id);
-- NULL is intentionally preserved for legacy payments with no recorded collector.
ALTER TABLE payments ADD COLUMN collector TEXT CHECK(collector IN ('roise','partner'));
ALTER TABLE payments ADD COLUMN partner_id TEXT REFERENCES commercial_partners(id);
CREATE UNIQUE INDEX payment_parent_currency ON payments(id,collection_id,client_id,currency);
CREATE TABLE payment_reversals (
 id TEXT PRIMARY KEY,payment_id TEXT NOT NULL,collection_id TEXT NOT NULL,client_id TEXT NOT NULL,currency TEXT NOT NULL,
 recorded_by TEXT NOT NULL REFERENCES users(id),amount_minor INTEGER NOT NULL CHECK(amount_minor>0),reversed_on TEXT NOT NULL,
 reason TEXT NOT NULL CHECK(length(trim(reason))>0),command_id TEXT NOT NULL,
 expected_revision INTEGER NOT NULL CHECK(expected_revision>0 AND expected_revision<9223372036854775807),
 collection_revision INTEGER NOT NULL CHECK(collection_revision=expected_revision+1),recorded_at TEXT NOT NULL,
 FOREIGN KEY(payment_id,collection_id,client_id,currency) REFERENCES payments(id,collection_id,client_id,currency),
 UNIQUE(collection_id,command_id),UNIQUE(collection_id,collection_revision)
) STRICT;
CREATE INDEX reversal_parent ON payment_reversals(payment_id,id);
CREATE INDEX reversal_collection ON payment_reversals(collection_id,id);
CREATE TABLE internal_settlements (
 id TEXT PRIMARY KEY,period_id TEXT NOT NULL,client_id TEXT NOT NULL,currency TEXT NOT NULL,
 direction TEXT NOT NULL CHECK(direction IN ('partner_to_roise','roise_to_partner')),
 amount_minor INTEGER NOT NULL CHECK(amount_minor>0),settled_on TEXT NOT NULL,
 reference TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',recorded_by TEXT NOT NULL REFERENCES users(id),
 command_id TEXT NOT NULL,command_hash TEXT NOT NULL CHECK(length(command_hash)=64),recorded_at TEXT NOT NULL,
 FOREIGN KEY(period_id,client_id,currency) REFERENCES billing_periods(id,client_id,currency),
 UNIQUE(period_id,command_id)
) STRICT;
CREATE INDEX internal_settlement_period ON internal_settlements(period_id,id);
CREATE TRIGGER commercial_payment_collector BEFORE INSERT ON payments WHEN
 (EXISTS(SELECT 1 FROM billing_periods b WHERE b.collection_id=NEW.collection_id) AND
  (NEW.collector IS NULL OR (NEW.collector='partner' AND NOT EXISTS(SELECT 1 FROM billing_periods b JOIN agreement_versions v ON v.id=b.version_id WHERE b.collection_id=NEW.collection_id AND v.partner_id=NEW.partner_id)) OR (NEW.collector='roise' AND NEW.partner_id IS NOT NULL))) OR
 (NOT EXISTS(SELECT 1 FROM billing_periods b WHERE b.collection_id=NEW.collection_id) AND (NEW.collector='partner' OR NEW.partner_id IS NOT NULL))
 BEGIN SELECT RAISE(ABORT,'invalid collector'); END;
CREATE TRIGGER payment_reversal_revision BEFORE INSERT ON payments WHEN
 NEW.expected_revision<>(SELECT revision FROM collections WHERE id=NEW.collection_id) OR EXISTS(SELECT 1 FROM payment_reversals r WHERE r.collection_id=NEW.collection_id AND r.collection_revision=NEW.collection_revision)
 BEGIN SELECT RAISE(ABORT,'ledger revision conflict'); END;
CREATE TRIGGER reversal_limits BEFORE INSERT ON payment_reversals WHEN
 NEW.expected_revision<>(SELECT revision FROM collections WHERE id=NEW.collection_id) OR
 EXISTS(SELECT 1 FROM payments p WHERE p.collection_id=NEW.collection_id AND p.collection_revision=NEW.collection_revision) OR
 NEW.amount_minor>(SELECT amount_minor FROM payments WHERE id=NEW.payment_id)-CAST(coalesce((SELECT exact_sum(amount_minor) FROM payment_reversals WHERE payment_id=NEW.payment_id),'0') AS INTEGER)
 BEGIN SELECT RAISE(ABORT,'invalid reversal'); END;
DROP TRIGGER collections_ledger;
CREATE TRIGGER collections_ledger BEFORE UPDATE OF paid_minor ON collections WHEN
 NEW.paid_minor<>CAST((SELECT exact_sum(amount) FROM (SELECT amount_minor AS amount FROM payments WHERE collection_id=NEW.id UNION ALL SELECT -amount_minor FROM payment_reversals WHERE collection_id=NEW.id)) AS INTEGER)
 BEGIN SELECT RAISE(ABORT,'balance must equal retained net ledger'); END;
CREATE TRIGGER reversals_apply AFTER INSERT ON payment_reversals BEGIN
 UPDATE collections SET paid_minor=paid_minor-NEW.amount_minor WHERE id=NEW.collection_id;
END;
CREATE TRIGGER period_terms_match BEFORE INSERT ON billing_periods WHEN
 (SELECT amount_minor FROM collections WHERE id=NEW.collection_id)<>(SELECT amount_minor FROM agreement_versions WHERE id=NEW.version_id)
 BEGIN SELECT RAISE(ABORT,'period terms mismatch'); END;
CREATE TRIGGER period_collection_locked BEFORE UPDATE ON collections WHEN
 EXISTS(SELECT 1 FROM billing_periods b WHERE b.collection_id=OLD.id AND
  (NEW.amount_minor<>OLD.amount_minor OR (NEW.cancelled_at IS NOT OLD.cancelled_at AND b.voided_at IS NULL)))
 BEGIN SELECT RAISE(ABORT,'commercial period workflow'); END;
CREATE TRIGGER partners_identity BEFORE UPDATE ON commercial_partners WHEN NEW.id<>OLD.id OR NEW.name<>OLD.name OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at OR OLD.archived_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER partners_retained BEFORE DELETE ON commercial_partners BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER agreements_identity BEFORE UPDATE ON service_agreements WHEN NEW.id<>OLD.id OR NEW.client_id<>OLD.client_id OR NEW.created_by<>OLD.created_by OR NEW.title<>OLD.title OR NEW.service_type<>OLD.service_type OR NEW.frequency<>OLD.frequency OR NEW.start_date<>OLD.start_date OR NEW.end_date IS NOT OLD.end_date OR NEW.anchor_day<>OLD.anchor_day OR NEW.due_offset_days<>OLD.due_offset_days OR NEW.timezone<>OLD.timezone OR NEW.command_id<>OLD.command_id OR NEW.command_hash<>OLD.command_hash OR NEW.created_at<>OLD.created_at BEGIN SELECT RAISE(ABORT,'retained identity'); END;
CREATE TRIGGER agreements_retained BEFORE DELETE ON service_agreements BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER agreement_versions_no_update BEFORE UPDATE ON agreement_versions BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER agreement_versions_no_delete BEFORE DELETE ON agreement_versions BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER periods_identity BEFORE UPDATE ON billing_periods WHEN NEW.id<>OLD.id OR NEW.agreement_id<>OLD.agreement_id OR NEW.client_id<>OLD.client_id OR NEW.version_id<>OLD.version_id OR NEW.collection_id<>OLD.collection_id OR NEW.currency<>OLD.currency OR NEW.period_key<>OLD.period_key OR NEW.billing_date<>OLD.billing_date OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at OR OLD.voided_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER periods_no_delete BEFORE DELETE ON billing_periods BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER reversals_no_update BEFORE UPDATE ON payment_reversals BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER reversals_no_delete BEFORE DELETE ON payment_reversals BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER internal_settlements_no_update BEFORE UPDATE ON internal_settlements BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER internal_settlements_no_delete BEFORE DELETE ON internal_settlements BEGIN SELECT RAISE(ABORT,'retained'); END;

CREATE TRIGGER settlements_require_partner BEFORE INSERT ON internal_settlements WHEN
 NOT EXISTS(SELECT 1 FROM billing_periods b JOIN agreement_versions v ON v.id=b.version_id WHERE b.id=NEW.period_id AND b.voided_at IS NULL AND v.partner_id IS NOT NULL)
 BEGIN SELECT RAISE(ABORT,'internal settlement requires partner'); END;

CREATE TABLE agreement_commands (
 agreement_id TEXT NOT NULL REFERENCES service_agreements(id),command_id TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES users(id),payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
 created_at TEXT NOT NULL,PRIMARY KEY(agreement_id,command_id)
) STRICT;
CREATE TRIGGER agreement_commands_no_update BEFORE UPDATE ON agreement_commands BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER agreement_commands_no_delete BEFORE DELETE ON agreement_commands BEGIN SELECT RAISE(ABORT,'retained'); END;

CREATE TABLE period_commands (
 period_id TEXT NOT NULL REFERENCES billing_periods(id),command_id TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES users(id),payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
 created_at TEXT NOT NULL,PRIMARY KEY(period_id,command_id)
) STRICT;
CREATE TRIGGER period_commands_no_update BEFORE UPDATE ON period_commands BEGIN SELECT RAISE(ABORT,'retained'); END;
CREATE TRIGGER period_commands_no_delete BEFORE DELETE ON period_commands BEGIN SELECT RAISE(ABORT,'retained'); END;
