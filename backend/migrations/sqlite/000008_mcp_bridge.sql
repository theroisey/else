-- Native delegated access. No existing business table or history is replaced.
CREATE TABLE mcp_settings (
 id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), updated_at TEXT NOT NULL
) STRICT;
INSERT INTO mcp_settings(id,updated_at) VALUES(1,strftime('%Y-%m-%dT%H:%M:%f000Z','now'));

CREATE TABLE mcp_applications (
 id TEXT PRIMARY KEY CHECK(length(id)=36), name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), revoked_at TEXT
) STRICT;
CREATE TABLE mcp_redirects (
 application_id TEXT NOT NULL REFERENCES mcp_applications(id), uri TEXT NOT NULL CHECK(length(uri) BETWEEN 1 AND 2048),
 PRIMARY KEY(application_id,uri)
) STRICT;
CREATE TABLE mcp_origins (
 application_id TEXT NOT NULL REFERENCES mcp_applications(id), origin TEXT NOT NULL CHECK(length(origin) BETWEEN 1 AND 512),
 PRIMARY KEY(application_id,origin)
) STRICT;

CREATE TABLE mcp_grants (
 id TEXT PRIMARY KEY CHECK(length(id)=36), user_id TEXT NOT NULL REFERENCES users(id),
 application_id TEXT NOT NULL REFERENCES mcp_applications(id), client_id TEXT REFERENCES client_scopes(id),
 resource TEXT NOT NULL CHECK(length(resource) BETWEEN 1 AND 2048),
 scopes TEXT NOT NULL CHECK(length(scopes) BETWEEN 1 AND 2048), created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL CHECK(expires_at>created_at), revoked_at TEXT
) STRICT;
CREATE INDEX mcp_grants_user ON mcp_grants(user_id,id);
CREATE INDEX mcp_grants_application ON mcp_grants(application_id,id);
CREATE INDEX mcp_grants_expiry ON mcp_grants(expires_at);
CREATE TRIGGER mcp_grant_identity BEFORE UPDATE ON mcp_grants
WHEN NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id OR NEW.application_id<>OLD.application_id
 OR NEW.client_id IS NOT OLD.client_id OR NEW.resource<>OLD.resource OR NEW.scopes<>OLD.scopes OR NEW.created_at<>OLD.created_at
 OR NEW.expires_at<>OLD.expires_at OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
BEGIN SELECT RAISE(ABORT,'immutable MCP authorization'); END;

CREATE TABLE mcp_authorizations (
 id TEXT PRIMARY KEY CHECK(length(id)=36), application_id TEXT NOT NULL REFERENCES mcp_applications(id),
 redirect_uri TEXT NOT NULL, resource TEXT NOT NULL, scopes TEXT NOT NULL,
 challenge TEXT NOT NULL CHECK(length(challenge)=43), state TEXT NOT NULL CHECK(length(state)<=512),
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK(expires_at>created_at), consumed_at TEXT
) STRICT;
CREATE INDEX mcp_authorizations_expiry ON mcp_authorizations(expires_at);
CREATE TABLE mcp_codes (
 token_hash BLOB PRIMARY KEY CHECK(length(token_hash)=32), authorization_id TEXT NOT NULL UNIQUE REFERENCES mcp_authorizations(id),
 grant_id TEXT NOT NULL REFERENCES mcp_grants(id), issued_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK(expires_at>issued_at),
 consumed_at TEXT
) STRICT;
CREATE INDEX mcp_codes_grant ON mcp_codes(grant_id);
CREATE TABLE mcp_access_tokens (
 token_hash BLOB PRIMARY KEY CHECK(length(token_hash)=32), grant_id TEXT NOT NULL REFERENCES mcp_grants(id),
 scopes TEXT NOT NULL CHECK(length(scopes) BETWEEN 1 AND 2048),
 issued_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK(expires_at>issued_at)
) STRICT;
CREATE INDEX mcp_access_grant ON mcp_access_tokens(grant_id);
CREATE INDEX mcp_access_expiry ON mcp_access_tokens(expires_at);
CREATE TRIGGER mcp_access_immutable BEFORE UPDATE ON mcp_access_tokens BEGIN SELECT RAISE(ABORT,'immutable MCP access token'); END;
CREATE TABLE mcp_refresh_tokens (
 token_hash BLOB PRIMARY KEY CHECK(length(token_hash)=32), grant_id TEXT NOT NULL REFERENCES mcp_grants(id),
 issued_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK(expires_at>issued_at), consumed_at TEXT
) STRICT;
CREATE INDEX mcp_refresh_expiry ON mcp_refresh_tokens(expires_at);
CREATE UNIQUE INDEX mcp_refresh_current ON mcp_refresh_tokens(grant_id) WHERE consumed_at IS NULL;
CREATE TRIGGER mcp_refresh_identity BEFORE UPDATE ON mcp_refresh_tokens
WHEN NEW.token_hash<>OLD.token_hash OR NEW.grant_id<>OLD.grant_id OR NEW.issued_at<>OLD.issued_at
 OR NEW.expires_at<>OLD.expires_at OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
BEGIN SELECT RAISE(ABORT,'immutable MCP refresh generation'); END;

CREATE TABLE mcp_approvals (
 id TEXT PRIMARY KEY CHECK(length(id)=36), user_id TEXT NOT NULL REFERENCES users(id),
 application_id TEXT NOT NULL REFERENCES mcp_applications(id), grant_id TEXT NOT NULL REFERENCES mcp_grants(id),
 command_id TEXT NOT NULL CHECK(length(command_id)=36), tool_name TEXT NOT NULL CHECK(length(tool_name)<=128),
 argument_digest TEXT NOT NULL CHECK(length(argument_digest)=64), arguments TEXT NOT NULL CHECK(length(arguments)<=49152),
 client_id TEXT REFERENCES client_scopes(id), created_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK(expires_at>created_at),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','denied','expired','revoked')),
 decided_at TEXT, consumed_at TEXT,
 CHECK((state='pending')=(decided_at IS NULL)), CHECK(consumed_at IS NULL OR state='approved')
) STRICT;
CREATE INDEX mcp_approval_actor ON mcp_approvals(user_id,id);
CREATE INDEX mcp_approval_expiry ON mcp_approvals(expires_at);
CREATE INDEX mcp_approval_command ON mcp_approvals(user_id,application_id,command_id);
CREATE TRIGGER mcp_approval_identity BEFORE UPDATE ON mcp_approvals
WHEN NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id OR NEW.application_id<>OLD.application_id
 OR NEW.grant_id<>OLD.grant_id OR NEW.command_id<>OLD.command_id OR NEW.tool_name<>OLD.tool_name
 OR NEW.argument_digest<>OLD.argument_digest OR NEW.arguments<>OLD.arguments OR NEW.client_id IS NOT OLD.client_id
 OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at
 OR (OLD.state<>'pending' AND (NEW.state<>OLD.state OR NEW.decided_at IS NOT OLD.decided_at))
 OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at)
BEGIN SELECT RAISE(ABORT,'immutable MCP approval'); END;

CREATE TABLE mcp_commands (
 user_id TEXT NOT NULL REFERENCES users(id), application_id TEXT NOT NULL REFERENCES mcp_applications(id),
 command_id TEXT NOT NULL CHECK(length(command_id)=36), grant_id TEXT NOT NULL REFERENCES mcp_grants(id),
 tool_name TEXT NOT NULL CHECK(length(tool_name)<=128), argument_digest TEXT NOT NULL CHECK(length(argument_digest)=64),
 resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL CHECK(length(resource_id)=36), revision TEXT,
 request_id TEXT NOT NULL CHECK(length(request_id)=26), transaction_token TEXT NOT NULL DEFAULT(transaction_token()) CHECK(length(transaction_token)=36), committed_at TEXT NOT NULL,
 PRIMARY KEY(user_id,application_id,command_id)
) STRICT;
CREATE TRIGGER mcp_commands_immutable BEFORE UPDATE ON mcp_commands BEGIN SELECT RAISE(ABORT,'immutable MCP command'); END;
CREATE TRIGGER mcp_commands_retained BEFORE DELETE ON mcp_commands BEGIN SELECT RAISE(ABORT,'retained MCP command'); END;
