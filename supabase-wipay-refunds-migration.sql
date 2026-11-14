BEGIN;
-- A transaction can have only one full WiPay refund attempt. Claim durably
-- before sending: WiPay documents no request-id/idempotency parameter.
CREATE TABLE IF NOT EXISTS wipay_refunds (
  transaction_id TEXT PRIMARY KEY,
  request_id TEXT UNIQUE NOT NULL REFERENCES refund_requests(request_id),
  environment TEXT NOT NULL CHECK (environment IN ('live','sandbox')),
  state TEXT NOT NULL,
  sync_started_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE wipay_refunds ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='wipay_refunds' AND policyname='service role manages wipay_refunds') THEN
    CREATE POLICY "service role manages wipay_refunds" ON wipay_refunds
      FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wipay_webhook_events (
  event_id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  event TEXT NOT NULL,
  transaction_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);
ALTER TABLE wipay_webhook_events ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='wipay_webhook_events' AND policyname='service role manages wipay_webhook_events') THEN
    CREATE POLICY "service role manages wipay_webhook_events" ON wipay_webhook_events
      FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
  END IF;
END $$;
COMMIT;
