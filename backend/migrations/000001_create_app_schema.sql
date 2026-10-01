-- +goose Up
CREATE SCHEMA app;
REVOKE ALL ON SCHEMA app FROM PUBLIC;

-- +goose Down
-- Deliberately no CASCADE: rollback must refuse to destroy later domain objects.
DROP SCHEMA app;
