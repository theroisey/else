//! Restore verification supplements structural foreign keys with domain invariants.
use super::*;
pub(crate) fn verify(tx: &Transaction<'_>) -> Result<()> {
    for query in [
        "SELECT EXISTS(SELECT 1 FROM technical_requests r JOIN tasks t ON t.id=r.task_id WHERE t.client_id<>r.client_id OR t.assignee_id IS NOT r.assignee_id OR t.archived_at IS NOT NULL OR t.status<>CASE r.status WHEN 'accepted' THEN 'todo' WHEN 'in_progress' THEN 'in_progress' WHEN 'revision_requested' THEN 'in_progress' WHEN 'delivered' THEN 'review' WHEN 'approved' THEN 'done' WHEN 'cancelled' THEN 'cancelled' ELSE t.status END) OR EXISTS(SELECT 1 FROM technical_requests r WHERE r.status IN ('accepted','in_progress','revision_requested','delivered','approved') AND r.task_id IS NULL)",
        "SELECT EXISTS(SELECT 1 FROM request_events e JOIN request_deliveries d ON d.id=e.delivery_id WHERE d.request_id<>e.request_id) OR EXISTS(SELECT 1 FROM delivery_reviews v JOIN request_deliveries d ON d.id=v.delivery_id WHERE v.reviewed_by=d.delivered_by)",
        "SELECT EXISTS(SELECT 1 FROM technical_requests r WHERE r.revision<>(SELECT count(*) FROM request_events e WHERE e.request_id=r.id) OR r.status<>(SELECT e.status FROM request_events e WHERE e.request_id=r.id ORDER BY e.sequence DESC LIMIT 1) OR r.delivery_count<>(SELECT count(*) FROM request_deliveries d WHERE d.request_id=r.id) OR r.revision<>(SELECT max(e.sequence) FROM request_events e WHERE e.request_id=r.id))",
        "SELECT EXISTS(SELECT 1 FROM request_deliveries d WHERE d.number<>(SELECT count(*) FROM request_deliveries x WHERE x.request_id=d.request_id AND x.number<=d.number))",
        "SELECT EXISTS(SELECT 1 FROM technical_requests r WHERE (r.status='approved' AND NOT EXISTS(SELECT 1 FROM request_deliveries d JOIN delivery_reviews v ON v.delivery_id=d.id WHERE d.request_id=r.id AND d.number=r.delivery_count AND v.decision='approved')) OR (r.status='revision_requested' AND NOT EXISTS(SELECT 1 FROM request_deliveries d JOIN delivery_reviews v ON v.delivery_id=d.id WHERE d.request_id=r.id AND d.number=r.delivery_count AND v.decision='revision_requested')))",
        "SELECT EXISTS(SELECT 1 FROM billing_periods b JOIN agreement_versions v ON v.id=b.version_id JOIN collections c ON c.id=b.collection_id WHERE c.amount_minor<>v.amount_minor OR c.currency<>v.currency OR ((b.voided_at IS NULL)<>(c.cancelled_at IS NULL)) OR (b.voided_at IS NOT NULL AND (EXISTS(SELECT 1 FROM payments p WHERE p.collection_id=c.id) OR EXISTS(SELECT 1 FROM internal_settlements s WHERE s.period_id=b.id))))",
        "SELECT EXISTS(SELECT 1 FROM payments p JOIN billing_periods b ON b.collection_id=p.collection_id JOIN agreement_versions v ON v.id=b.version_id WHERE p.collector IS NULL OR (p.collector='roise' AND p.partner_id IS NOT NULL) OR (p.collector='partner' AND (p.partner_id IS NULL OR p.partner_id IS NOT v.partner_id)))",
        "SELECT EXISTS(SELECT 1 FROM payments p WHERE p.amount_minor<CAST((SELECT exact_sum(r.amount_minor) FROM payment_reversals r WHERE r.payment_id=p.id) AS INTEGER)) OR EXISTS(SELECT 1 FROM payment_reversals r JOIN payments p ON p.id=r.payment_id WHERE r.reversed_on<p.paid_on)",
        "SELECT EXISTS(SELECT 1 FROM recurring_tasks t WHERE t.generated_count<>(SELECT count(*) FROM recurring_task_occurrences o WHERE o.template_id=t.id) OR t.current_version<>(SELECT max(v.number) FROM recurring_task_versions v WHERE v.template_id=t.id))",
        "SELECT EXISTS(SELECT 1 FROM recurring_task_occurrences o JOIN tasks t ON t.id=o.task_id JOIN recurring_task_versions v ON v.id=o.version_id WHERE t.client_id<>o.client_id OR v.template_id<>o.template_id OR v.client_id<>o.client_id OR o.scheduled_date<v.start_date OR (v.end_date IS NOT NULL AND o.scheduled_date>v.end_date))",
        "SELECT EXISTS(SELECT 1 FROM recurring_task_versions v WHERE v.number<>(SELECT count(*) FROM recurring_task_versions x WHERE x.template_id=v.template_id AND x.number<=v.number)) OR EXISTS(SELECT 1 FROM agreement_versions v WHERE v.number<>(SELECT count(*) FROM agreement_versions x WHERE x.agreement_id=v.agreement_id AND x.number<=v.number))",
    ] {
        if tx.query_row(query, [], |r| r.get::<_, bool>(0))? {
            return Err(Error::Internal);
        }
    }
    for query in [
        "SELECT start_date,next_date,timezone FROM service_agreements",
        "SELECT v.start_date,r.next_date,v.timezone FROM recurring_tasks r JOIN recurring_task_versions v ON v.template_id=r.id AND v.number=r.current_version",
    ] {
        let mut stmt = tx.prepare(query)?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            schedule::date(&row.get::<_, String>(0)?)?;
            schedule::date(&row.get::<_, String>(1)?)?;
            schedule::zone(&row.get::<_, String>(2)?)?;
        }
    }
    Ok(())
}
