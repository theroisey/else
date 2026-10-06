-- Test-only identity, deliberately public synthetic password:
-- "clearly synthetic browser password". Never provision this in a real environment.
-- Real synthetic scope record required by the client assignment boundary.
INSERT INTO client_scopes(id) VALUES ('22222222-2222-4222-8222-222222222222');
INSERT INTO clients(id,name,created_at,updated_at) VALUES ('22222222-2222-4222-8222-222222222222','Synthetic Browser Client',utc_now(),utc_now());
INSERT INTO users(id,email,display_name,password_hash,status,created_at,updated_at) VALUES
('11111111-1111-4111-8111-111111111111', 'browser.fixture@example.com', 'Browser Fixture',
 '$argon2id$v=19$m=19456,t=2,p=1$Zml4dHVyZS1vbmx5c2FsdA$q44qWGtBzhKQ/qhlHB+AxsHnTl623ugz2P+BkSW2ZxQ','active',utc_now(),utc_now());
INSERT INTO user_roles(id,user_id,role_id,scope_kind,client_id,assigned_at) VALUES
('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111',
 '00000000-0000-4000-8000-000000000003', 'client', '22222222-2222-4222-8222-222222222222',utc_now());

-- Separate synthetic administrator for the administration flow, using the same
-- deliberately public test password. This file is isolated browser-test data.
INSERT INTO users(id,email,display_name,password_hash,status,created_at,updated_at) VALUES
('44444444-4444-4444-8444-444444444444', 'admin.fixture@example.com', 'Administration Fixture',
 '$argon2id$v=19$m=19456,t=2,p=1$Zml4dHVyZS1vbmx5c2FsdA$q44qWGtBzhKQ/qhlHB+AxsHnTl623ugz2P+BkSW2ZxQ','active',utc_now(),utc_now());
INSERT INTO user_roles(id,user_id,role_id,scope_kind,client_id,assigned_at) VALUES
('55555555-5555-4555-8555-555555555555', '44444444-4444-4444-8444-444444444444',
 '00000000-0000-4000-8000-000000000001', 'global', NULL,utc_now());

-- A dedicated scoped viewer keeps client verification independent of the
-- login attempt budget consumed by session/expiry tests above.
INSERT INTO users(id,email,display_name,password_hash,status,created_at,updated_at) VALUES
('77777777-7777-4777-8777-777777777777', 'client.viewer.fixture@example.com', 'Client Viewer Fixture',
 '$argon2id$v=19$m=19456,t=2,p=1$Zml4dHVyZS1vbmx5c2FsdA$q44qWGtBzhKQ/qhlHB+AxsHnTl623ugz2P+BkSW2ZxQ','active',utc_now(),utc_now());
INSERT INTO user_roles(id,user_id,role_id,scope_kind,client_id,assigned_at) VALUES
('88888888-8888-4888-8888-888888888888', '77777777-7777-4777-8777-777777777777',
 '00000000-0000-4000-8000-000000000003', 'client', '22222222-2222-4222-8222-222222222222',utc_now());

-- Independent task-only viewer; its dedicated scope is provisioned by the task
-- flow after earlier pagination checks. Same deliberately public test password.
INSERT INTO users(id,email,display_name,password_hash,status,created_at,updated_at) VALUES
('99999999-9999-4999-8999-999999999999', 'task.viewer.fixture@example.com', 'Task Viewer Fixture',
 '$argon2id$v=19$m=19456,t=2,p=1$Zml4dHVyZS1vbmx5c2FsdA$q44qWGtBzhKQ/qhlHB+AxsHnTl623ugz2P+BkSW2ZxQ','active',utc_now(),utc_now());
