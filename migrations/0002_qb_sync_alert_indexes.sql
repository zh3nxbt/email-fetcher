-- Performance indexes for alert queries
CREATE INDEX IF NOT EXISTS qb_sync_alerts_status_type_detected_idx
  ON qb_sync_alerts (status, alert_type, detected_at);

CREATE INDEX IF NOT EXISTS qb_sync_alerts_thread_key_idx
  ON qb_sync_alerts (thread_key);

CREATE INDEX IF NOT EXISTS qb_sync_alerts_sales_order_id_idx
  ON qb_sync_alerts (sales_order_id);

CREATE INDEX IF NOT EXISTS qb_sync_alerts_qb_customer_id_idx
  ON qb_sync_alerts (qb_customer_id);

-- Idempotency for open alerts (prevents duplicates under concurrent runs)
CREATE UNIQUE INDEX IF NOT EXISTS qb_sync_alerts_open_thread_unique
  ON qb_sync_alerts (thread_key)
  WHERE status = 'open' AND alert_type <> 'so_should_be_closed';

CREATE UNIQUE INDEX IF NOT EXISTS qb_sync_alerts_open_so_unique
  ON qb_sync_alerts (sales_order_id)
  WHERE status = 'open' AND alert_type = 'so_should_be_closed' AND sales_order_id IS NOT NULL;
