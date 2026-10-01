-- Test-only identity, deliberately public synthetic password:
-- "clearly synthetic browser password". Never provision this in a real environment.
INSERT INTO app.users (id, email, display_name, password_hash) VALUES
('11111111-1111-4111-8111-111111111111', 'browser.fixture@example.com', 'Browser Fixture',
 '$argon2id$v=19$m=19456,t=2,p=1$Zml4dHVyZS1vbmx5c2FsdA$q44qWGtBzhKQ/qhlHB+AxsHnTl623ugz2P+BkSW2ZxQ');
INSERT INTO app.user_roles (id, user_id, role_id, scope_kind, client_id) VALUES
('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111',
 '00000000-0000-4000-8000-000000000003', 'client', '22222222-2222-4222-8222-222222222222');

-- Separate synthetic administrator for the administration flow, using the same
-- deliberately public test password. This file is isolated browser-test data.
INSERT INTO app.users (id, email, display_name, password_hash) VALUES
('44444444-4444-4444-8444-444444444444', 'admin.fixture@example.com', 'Administration Fixture',
 '$argon2id$v=19$m=19456,t=2,p=1$Zml4dHVyZS1vbmx5c2FsdA$q44qWGtBzhKQ/qhlHB+AxsHnTl623ugz2P+BkSW2ZxQ');
INSERT INTO app.user_roles (id, user_id, role_id, scope_kind, client_id) VALUES
('55555555-5555-4555-8555-555555555555', '44444444-4444-4444-8444-444444444444',
 '00000000-0000-4000-8000-000000000001', 'global', NULL);
