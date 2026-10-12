-- Cross-brand daily work needs global ordering rather than per-client sorts.
-- Existing client indexes and all retained records remain unchanged.
CREATE INDEX tasks_global_attention
 ON tasks((due_at IS NULL),due_at,id)
 WHERE archived_at IS NULL AND status NOT IN ('done','cancelled');
CREATE INDEX reminders_global_attention
 ON reminders(scheduled_at,id)
 WHERE status='pending';
-- Currency-separated outstanding summaries read a narrow live index instead
-- of loading every financial description/history row.
CREATE INDEX collections_global_outstanding
 ON collections(currency,amount_minor,paid_minor,due_date,client_id)
 WHERE cancelled_at IS NULL AND paid_minor<amount_minor;
