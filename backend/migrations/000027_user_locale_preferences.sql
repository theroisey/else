-- +goose Up
CREATE TABLE app.user_locale_preferences (
 user_id uuid PRIMARY KEY REFERENCES app.users(id),
 locale text NOT NULL CHECK(locale IN ('en','tr','ro','de','fr')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0)
);
-- +goose StatementBegin
CREATE FUNCTION app.user_locale_read(actor uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(871092650209);
 IF NOT EXISTS(SELECT 1 FROM app.users WHERE id=actor AND status='active') THEN RAISE no_data_found; END IF;
 RETURN (SELECT locale FROM app.user_locale_preferences WHERE user_id=actor);
END; $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION app.user_locale_write(actor uuid,selected text) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE task_revision bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(871092650209);
 IF NOT EXISTS(SELECT 1 FROM app.users WHERE id=actor AND status='active') THEN RAISE no_data_found; END IF;
 IF selected IS NULL OR selected NOT IN ('en','tr','ro','de','fr') THEN RAISE invalid_parameter_value; END IF;
 INSERT INTO app.user_locale_preferences(user_id,locale) VALUES(actor,selected)
 ON CONFLICT(user_id) DO UPDATE SET locale=excluded.locale,revision=app.user_locale_preferences.revision+1 RETURNING revision INTO task_revision;
 RETURN task_revision;
END; $$;
-- +goose StatementEnd
REVOKE ALL ON app.user_locale_preferences FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.user_locale_read(uuid),app.user_locale_write(uuid,text) FROM PUBLIC;
-- +goose Down
LOCK TABLE app.user_locale_preferences IN ACCESS EXCLUSIVE MODE;
-- +goose StatementBegin
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM app.user_locale_preferences) OR EXISTS(SELECT 1 FROM app.audit_events WHERE resource_kind='user_preference') THEN
 RAISE EXCEPTION 'Rollback refused: user preference history is not empty'; END IF;
END; $$;
-- +goose StatementEnd
DROP FUNCTION app.user_locale_read(uuid),app.user_locale_write(uuid,text);
DROP TABLE app.user_locale_preferences;
