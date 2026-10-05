-- Evaluate current client visibility once per directory statement. No table,
-- API, permission catalogue or mutation/audit change; retain the function ACL.
-- +goose Up
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.client_list(actor uuid,after_id uuid,page_limit integer,state text,search text,tag_filter text,descending boolean) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE global_view boolean; scoped_clients uuid[];
BEGIN
 -- The identical effective grant set belongs to this statement's snapshot.
 -- Evaluate once, rather than joining roles/permissions for every candidate row.
 SELECT coalesce(bool_or(g.scope_kind='global'),false),
  coalesce(array_agg(g.client_id) FILTER (WHERE g.scope_kind='client'),'{}'::uuid[])
 INTO global_view,scoped_clients
 FROM app.authorization_grants(actor) g WHERE g.permission_key='clients.view';
 IF NOT global_view AND cardinality(scoped_clients)=0 THEN RAISE insufficient_privilege; END IF;
 IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 101 OR state IS NULL OR state NOT IN ('active','archived','all') OR
  search IS NULL OR char_length(search)>100 OR tag_filter IS NULL OR char_length(tag_filter)>40 OR descending IS NULL THEN RAISE invalid_parameter_value; END IF;
 RETURN QUERY SELECT app.client_document(c.id,false) FROM app.clients c
 WHERE (global_view OR c.id=ANY(scoped_clients))
  AND (state='all' OR (state='active' AND c.archived_at IS NULL) OR (state='archived' AND c.archived_at IS NOT NULL))
  AND (search='' OR strpos(lower(c.name),lower(search))>0)
  AND (tag_filter='' OR EXISTS (SELECT 1 FROM app.client_tags t WHERE t.client_id=c.id AND t.tag=tag_filter))
  AND (after_id IS NULL OR (NOT descending AND c.id>after_id) OR (descending AND c.id<after_id))
 ORDER BY CASE WHEN NOT descending THEN c.id END ASC,CASE WHEN descending THEN c.id END DESC LIMIT page_limit;
END; $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION app.client_list(actor uuid,after_id uuid,page_limit integer,state text,search text,tag_filter text,descending boolean) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM app.authorization_grants(actor) WHERE permission_key='clients.view') THEN RAISE insufficient_privilege; END IF;
 IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 101 OR state IS NULL OR state NOT IN ('active','archived','all') OR
  search IS NULL OR char_length(search)>100 OR tag_filter IS NULL OR char_length(tag_filter)>40 OR descending IS NULL THEN RAISE invalid_parameter_value; END IF;
 RETURN QUERY SELECT app.client_document(c.id,false) FROM app.clients c
 WHERE app.authorization_allowed(actor,'clients.view',c.id)
  AND (state='all' OR (state='active' AND c.archived_at IS NULL) OR (state='archived' AND c.archived_at IS NOT NULL))
  AND (search='' OR strpos(lower(c.name),lower(search))>0)
  AND (tag_filter='' OR EXISTS (SELECT 1 FROM app.client_tags t WHERE t.client_id=c.id AND t.tag=tag_filter))
  AND (after_id IS NULL OR (NOT descending AND c.id>after_id) OR (descending AND c.id<after_id))
 ORDER BY CASE WHEN NOT descending THEN c.id END ASC,CASE WHEN descending THEN c.id END DESC LIMIT page_limit;
END; $$;
-- +goose StatementEnd
