-- Explicit synthetic integration metadata only, never a production/demo seed.
-- No credentials or provider access exist for these isolated browser records.
INSERT INTO client_scopes(id) VALUES ('f8555555-5555-4555-8555-555555555555');
INSERT INTO clients(id,name,created_at,updated_at) VALUES ('f8555555-5555-4555-8555-555555555555','Synthetic integration client',utc_now(),utc_now());
INSERT INTO users(id,email,display_name,password_hash,status,created_at,updated_at) SELECT 'f8111111-1111-4111-8111-111111111111','integration.fixture@example.com','Integration Fixture',password_hash,'active',utc_now(),utc_now() FROM users WHERE id='44444444-4444-4444-8444-444444444444';
INSERT INTO roles(id,role_key,display_name,created_at,updated_at) VALUES ('f8222222-2222-4222-8222-222222222222','integration_fixture','Synthetic integration role',utc_now(),utc_now());
INSERT INTO role_permissions(id,role_id,permission_key,assigned_at) SELECT new_id(),'f8222222-2222-4222-8222-222222222222',permission_key,utc_now() FROM permissions WHERE permission_key IN ('clients.view','integrations.view','integrations.manage');
INSERT INTO user_roles(id,user_id,role_id,scope_kind,client_id,assigned_at) VALUES(new_id(),'f8111111-1111-4111-8111-111111111111','f8222222-2222-4222-8222-222222222222','client','f8555555-5555-4555-8555-555555555555',utc_now());
INSERT INTO integration_connections(id,client_id,provider,provider_account_id,state,revision,generation,created_at,updated_at) SELECT ('f8900000-0000-4000-8000-' || printf('%012d',i)),
  'f8555555-5555-4555-8555-555555555555','meta_ads',(8000000+i),
  CASE i WHEN 1 THEN 'connected' WHEN 3 THEN 'reauthorization_required'
    WHEN 4 THEN 'disconnect_pending' WHEN 5 THEN 'revocation_failed'
    WHEN 6 THEN 'disconnected' ELSE 'pending' END,
  CASE i WHEN 1 THEN 9007199254740993 ELSE 1 END,1,utc_now(),utc_now() FROM (WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<26) SELECT i FROM seq) seq;
