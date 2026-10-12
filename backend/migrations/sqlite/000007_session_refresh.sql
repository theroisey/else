-- Legacy access sessions are unchanged; refresh families exist only for new logins.
CREATE TABLE session_refresh_tokens (
    token_hash BLOB PRIMARY KEY CHECK(length(token_hash)=32),
    session_id TEXT NOT NULL REFERENCES sessions(id),
    csrf_hash BLOB NOT NULL CHECK(length(csrf_hash)=32),
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL CHECK(expires_at>issued_at),
    consumed_at TEXT CHECK(consumed_at IS NULL OR consumed_at>=issued_at)
) STRICT;
CREATE UNIQUE INDEX session_refresh_current ON session_refresh_tokens(session_id) WHERE consumed_at IS NULL;
CREATE INDEX session_refresh_expiry ON session_refresh_tokens(expires_at);
CREATE TRIGGER session_refresh_identity BEFORE UPDATE ON session_refresh_tokens
WHEN NEW.token_hash<>OLD.token_hash OR NEW.session_id<>OLD.session_id OR NEW.csrf_hash<>OLD.csrf_hash
  OR NEW.issued_at<>OLD.issued_at OR NEW.expires_at<>OLD.expires_at
  OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
BEGIN SELECT RAISE(ABORT,'immutable refresh generation'); END;
