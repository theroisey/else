-- Explicit synthetic integration metadata only, never a production/demo seed.
-- No credentials or provider access exist for these isolated browser records.
INSERT INTO app.client_scopes(id) VALUES ('f8555555-5555-4555-8555-555555555555');
INSERT INTO app.clients(id,name) VALUES ('f8555555-5555-4555-8555-555555555555','Synthetic integration client');
INSERT INTO app.users(id,email,display_name,password_hash)
SELECT 'f8111111-1111-4111-8111-111111111111','integration.fixture@example.com','Integration Fixture',password_hash
FROM app.users WHERE id='44444444-4444-4444-8444-444444444444';
INSERT INTO app.roles(id,role_key,display_name) VALUES ('f8222222-2222-4222-8222-222222222222','integration_fixture','Synthetic integration role');
INSERT INTO app.role_permissions(id,role_id,permission_key)
SELECT gen_random_uuid(),'f8222222-2222-4222-8222-222222222222',permission_key
FROM app.permissions WHERE permission_key IN ('clients.view','integrations.view','integrations.manage');
INSERT INTO app.user_roles(id,user_id,role_id,scope_kind,client_id)
VALUES(gen_random_uuid(),'f8111111-1111-4111-8111-111111111111','f8222222-2222-4222-8222-222222222222','client','f8555555-5555-4555-8555-555555555555');
INSERT INTO app.integration_connections(id,client_id,provider,provider_account_id,state,revision)
SELECT ('f8900000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,
  'f8555555-5555-4555-8555-555555555555','meta_ads',(8000000+i)::text,
  CASE i WHEN 1 THEN 'connected' WHEN 3 THEN 'reauthorization_required'
    WHEN 4 THEN 'disconnect_pending' WHEN 5 THEN 'revocation_failed'
    WHEN 6 THEN 'disconnected' ELSE 'pending' END,
  CASE i WHEN 1 THEN 9007199254740993::bigint ELSE 1 END
FROM generate_series(1,26) AS i;
