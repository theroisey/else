-- Additive identity migration: no existing account, session or grant changes.
CREATE TABLE auth_otp_challenges (
 id TEXT PRIMARY KEY CHECK(length(id)=43),
 user_id TEXT REFERENCES users(id),
 purpose TEXT NOT NULL DEFAULT 'authentication' CHECK(purpose='authentication'),
 key_label TEXT NOT NULL REFERENCES integration_encryption_keys(key_label),
 otp_digest BLOB NOT NULL CHECK(length(otp_digest)=32),
 browser_digest BLOB NOT NULL CHECK(length(browser_digest)=32),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 state TEXT NOT NULL CHECK(state IN ('queued','sending','delivered','consumed','invalidated','exhausted')),
 consumed_at INTEGER,
 CHECK((state='consumed')=(consumed_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX otp_current_account ON auth_otp_challenges(user_id) WHERE state IN ('queued','sending','delivered');
CREATE INDEX otp_account ON auth_otp_challenges(user_id,state);
CREATE INDEX otp_expiration ON auth_otp_challenges(expires_at);
CREATE TABLE auth_otp_rate_events (
 id INTEGER PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('request_email','request_peer','request_global','verify_peer','verify_global')),
 subject BLOB NOT NULL CHECK(length(subject)=32),
 occurred_at INTEGER NOT NULL
) STRICT;
CREATE INDEX otp_rate_window ON auth_otp_rate_events(kind,subject,occurred_at);
CREATE INDEX otp_rate_expiration ON auth_otp_rate_events(occurred_at);
CREATE TABLE auth_email_outbox (
 challenge_id TEXT PRIMARY KEY REFERENCES auth_otp_challenges(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id),
 key_id TEXT NOT NULL REFERENCES integration_encryption_keys(id),
 envelope BLOB CHECK(envelope IS NULL OR length(envelope) BETWEEN 31 AND 16478),
 deadline INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','sending','sent','failed')),
 CHECK((state IN ('queued','sending'))=(envelope IS NOT NULL))
) STRICT;
CREATE INDEX otp_outbox_queue ON auth_email_outbox(state,deadline);
