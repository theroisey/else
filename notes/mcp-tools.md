# Reviewed MCP tool inventory

All tools call the existing domain service; discovery is filtered by current authority and the delegated ceiling. Scope is necessary, never sufficient. Input/output schemas, native read prerequisites, revisions, side effects and retry rules are in `tools/list`. `Command receipt` denotes an idempotent standard mutation; `Browser approval` also requires exact-payload approval. Optional unsupported operations are not included. See [contracts and setup](mcp.md).

| Tool | Delegated scope | Mutation boundary |
| --- | --- | --- |
| `else_agreements_change` | `finance:write` | Browser approval |
| `else_agreements_create` | `finance:write` | Browser approval |
| `else_agreements_generate` | `finance:write` | Browser approval |
| `else_agreements_get` | `finance:read` | Read only |
| `else_agreements_list` | `finance:read` | Read only |
| `else_agreements_periods` | `finance:read` | Read only |
| `else_agreements_versions` | `finance:read` | Read only |
| `else_analytics_connections` | `analytics:read` | Read only |
| `else_analytics_report` | `analytics:read` | Read only |
| `else_audit_get` | `audit:read` | Read only |
| `else_audit_list` | `audit:read` | Read only |
| `else_clients_archive` | `clients:write` | Browser approval |
| `else_clients_create` | `clients:write` | Command receipt |
| `else_clients_get` | `clients:read` | Read only |
| `else_clients_list` | `clients:read` | Read only |
| `else_clients_overview` | `clients:read` | Read only |
| `else_clients_update` | `clients:write` | Command receipt |
| `else_collections_cancel` | `finance:write` | Browser approval |
| `else_collections_create` | `finance:write` | Browser approval |
| `else_collections_get` | `finance:read` | Read only |
| `else_collections_list` | `finance:read` | Read only |
| `else_collections_payments` | `finance:read` | Read only |
| `else_collections_record_payment` | `finance:write` | Browser approval |
| `else_collections_reversals` | `finance:read` | Read only |
| `else_collections_reverse_payment` | `finance:write` | Browser approval |
| `else_collections_update` | `finance:write` | Browser approval |
| `else_finance_currencies` | `finance:read` | Read only |
| `else_finance_summary` | `finance:read` | Read only |
| `else_identity` | `Authenticated identity` | Read only |
| `else_milestones_archive` | `planning:write` | Browser approval |
| `else_milestones_create` | `planning:write` | Command receipt |
| `else_milestones_get` | `planning:read` | Read only |
| `else_milestones_links` | `planning:read` | Read only |
| `else_milestones_list` | `planning:read` | Read only |
| `else_milestones_replace_links` | `planning:write` | Command receipt |
| `else_milestones_status` | `planning:write` | Command receipt |
| `else_milestones_update` | `planning:write` | Command receipt |
| `else_notifications_list` | `notifications:read` | Read only |
| `else_notifications_mark_read` | `notifications:write` | Command receipt |
| `else_periods_get` | `finance:read` | Read only |
| `else_periods_list` | `finance:read` | Read only |
| `else_periods_settle` | `finance:write` | Browser approval |
| `else_periods_settlements` | `finance:read` | Read only |
| `else_periods_void` | `finance:write` | Browser approval |
| `else_plans_archive` | `planning:write` | Browser approval |
| `else_plans_create` | `planning:write` | Command receipt |
| `else_plans_get` | `planning:read` | Read only |
| `else_plans_list` | `planning:read` | Read only |
| `else_plans_status` | `planning:write` | Command receipt |
| `else_plans_update` | `planning:write` | Command receipt |
| `else_pricing_append` | `finance:write` | Browser approval |
| `else_pricing_copy` | `finance:write` | Browser approval |
| `else_pricing_create` | `finance:write` | Browser approval |
| `else_pricing_get` | `finance:read` | Read only |
| `else_pricing_list` | `finance:read` | Read only |
| `else_pricing_preview` | `finance:write` | Read only |
| `else_pricing_snapshot` | `finance:read` | Read only |
| `else_pricing_version` | `finance:read` | Read only |
| `else_pricing_versions` | `finance:read` | Read only |
| `else_recurring_change` | `recurring:write` | Command receipt |
| `else_recurring_create` | `recurring:write` | Command receipt |
| `else_recurring_generate` | `recurring:write` | Browser approval |
| `else_recurring_get` | `recurring:read` | Read only |
| `else_recurring_list` | `recurring:read` | Read only |
| `else_recurring_occurrences` | `recurring:read` | Read only |
| `else_recurring_versions` | `recurring:read` | Read only |
| `else_reminders_complete` | `reminders:write` | Command receipt |
| `else_reminders_create` | `reminders:write` | Command receipt |
| `else_reminders_dismiss` | `reminders:write` | Command receipt |
| `else_reminders_get` | `reminders:read` | Read only |
| `else_reminders_list` | `reminders:read` | Read only |
| `else_reminders_update` | `reminders:write` | Command receipt |
| `else_requests_accept` | `requests:develop` | Command receipt |
| `else_requests_approve` | `requests:review` | Command receipt |
| `else_requests_assign` | `requests:develop` | Command receipt |
| `else_requests_cancel` | `requests:write` | Browser approval |
| `else_requests_comment` | `requests:write` | Command receipt |
| `else_requests_create` | `requests:write` | Command receipt |
| `else_requests_deliver` | `requests:develop` | Command receipt |
| `else_requests_deliveries` | `requests:read` | Read only |
| `else_requests_get` | `requests:read` | Read only |
| `else_requests_list` | `requests:read` | Read only |
| `else_requests_reject` | `requests:develop` | Command receipt |
| `else_requests_reopen` | `requests:write` | Command receipt |
| `else_requests_revise` | `requests:review` | Command receipt |
| `else_requests_start` | `requests:develop` | Command receipt |
| `else_requests_timeline` | `requests:read` | Read only |
| `else_roles_assign` | `admin:write` | Browser approval |
| `else_roles_create` | `admin:write` | Browser approval |
| `else_roles_get` | `admin:read` | Read only |
| `else_roles_list` | `admin:read` | Read only |
| `else_roles_replace_permissions` | `admin:write` | Browser approval |
| `else_roles_revoke` | `admin:write` | Browser approval |
| `else_tasks_archive` | `tasks:write` | Browser approval |
| `else_tasks_assign` | `tasks:write` | Command receipt |
| `else_tasks_assignees` | `tasks:write` | Read only |
| `else_tasks_create` | `tasks:write` | Command receipt |
| `else_tasks_get` | `tasks:read` | Read only |
| `else_tasks_list` | `tasks:read` | Read only |
| `else_tasks_queue` | `tasks:read` | Read only |
| `else_tasks_status` | `tasks:write` | Command receipt |
| `else_tasks_update` | `tasks:write` | Command receipt |
| `else_teams_assign_brand` | `teams:write` | Browser approval |
| `else_teams_assignments` | `teams:read` | Read only |
| `else_teams_create` | `teams:write` | Browser approval |
| `else_teams_get` | `teams:read` | Read only |
| `else_teams_leadership_history` | `teams:read` | Read only |
| `else_teams_list` | `teams:read` | Read only |
| `else_teams_members` | `teams:read` | Read only |
| `else_teams_membership` | `teams:write` | Browser approval |
| `else_teams_update` | `teams:write` | Browser approval |
| `else_today` | `clients:read` | Read only |
| `else_users_disable` | `admin:write` | Browser approval |
| `else_users_get` | `admin:read` | Read only |
| `else_users_list` | `admin:read` | Read only |
| `else_users_update` | `admin:write` | Browser approval |
| `else_websites_archive` | `clients:write` | Browser approval |
| `else_websites_create` | `clients:write` | Command receipt |
| `else_websites_get` | `clients:read` | Read only |
| `else_websites_list` | `clients:read` | Read only |
| `else_websites_update` | `clients:write` | Command receipt |

## Financial intelligence reads

| Tool | Scope | Current authority |
| --- | --- | --- |
| `else_financial_dashboard` | finance:read | Current client + billing view; company permission for an unfiltered company view |
| `else_financial_receivables` | finance:read | Same scope and bounded receivable pages |
| `else_financial_payments` | finance:read | Same scope and bounded business-date payment/reversal pages |
| `else_financial_clients` | finance:read | Same scope and bounded client position pages |

Query filters match the native financial reports. Each call rechecks delegation, current resource authority and its brand ceiling. Operating-expense authority remains separate; no new write tool is added.
