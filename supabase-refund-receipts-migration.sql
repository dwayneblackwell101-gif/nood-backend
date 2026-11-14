BEGIN;
CREATE TABLE IF NOT EXISTS refund_requests (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
  request_id TEXT UNIQUE NOT NULL,
  order_id TEXT NOT NULL,
  order_number TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  user_id TEXT,
  amount NUMERIC NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  refund_method TEXT NOT NULL CHECK (refund_method IN ('original_payment', 'wallet')),
  payment_provider TEXT,
  payment_method TEXT,
  payment_transaction_id TEXT,
  shopify_order_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  notes TEXT,
  items JSONB DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN (
    'pending_review', 'approved', 'rejected', 'refunded_to_wallet',
    'refunded_to_original', 'partially_refunded', 'manual_refund_required',
    'failed', 'cancelled'
  )),
  admin_notes TEXT,
  refund_destination_label TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS id UUID;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS order_id TEXT;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS order_number TEXT;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS customer_email TEXT;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS amount NUMERIC;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS refund_method TEXT;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS payment_provider TEXT;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS payment_transaction_id TEXT;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS shopify_order_id TEXT;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS items JSONB DEFAULT '[]';
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending_review';
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS admin_notes TEXT;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS refund_destination_label TEXT;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE refund_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage refund_requests" ON refund_requests;
CREATE POLICY "service role can manage refund_requests" ON refund_requests
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

CREATE INDEX IF NOT EXISTS refund_requests_shopify_order_id_idx ON refund_requests (shopify_order_id);
CREATE INDEX IF NOT EXISTS refund_requests_user_id_idx ON refund_requests (user_id);
CREATE INDEX IF NOT EXISTS refund_requests_customer_email_idx ON refund_requests (customer_email);
CREATE INDEX IF NOT EXISTS refund_requests_status_idx ON refund_requests (status);
CREATE INDEX IF NOT EXISTS refund_requests_request_id_idx ON refund_requests (request_id);

-- ============================================================

ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS provider_refund_id TEXT;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS provider_refund_status TEXT;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS shopify_refund_id TEXT;

COMMIT;
