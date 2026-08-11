-- ============================================================
-- NOOD — Production Supabase Migration (Idempotent)
-- Run this ONCE in Supabase SQL Editor to create/update all tables
-- used by the deployed backend code.
-- Safe to re-run: uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. Push Notification Tokens
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS push_tokens (
  token TEXT PRIMARY KEY,
  platform TEXT DEFAULT 'android',
  device_id TEXT,
  user_id TEXT,
  email TEXT,
  app_version TEXT,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE push_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "service role can manage push_tokens" ON push_tokens
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ─────────────────────────────────────────────
-- 2. Push Campaign Events (dedupe + stats)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS push_campaign_events (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
  campaign_id TEXT UNIQUE NOT NULL,
  campaign_type TEXT NOT NULL DEFAULT 'general',
  dedupe_key TEXT UNIQUE,
  title TEXT,
  body TEXT,
  payload JSONB DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'created',
  recipient_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE push_campaign_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "service role can manage push_campaign_events" ON push_campaign_events
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

CREATE INDEX IF NOT EXISTS push_campaign_events_dedupe_key_idx
  ON push_campaign_events (dedupe_key);

-- ─────────────────────────────────────────────
-- 3. Push Frequency (per-token, per-day + user_id)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS push_frequency (
  token TEXT NOT NULL,
  day TEXT NOT NULL,
  user_id TEXT,  -- added by migration
  promo_count INTEGER NOT NULL DEFAULT 0,
  last_promo_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (token, day)
);

ALTER TABLE push_frequency ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "service role can manage push_frequency" ON push_frequency
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- Add user_id column if missing (idempotent)
ALTER TABLE push_frequency ADD COLUMN IF NOT EXISTS user_id TEXT;

-- ─────────────────────────────────────────────
-- 4. Push Cart Nudges (cooldown)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS push_cart_nudges (
  cart_key TEXT PRIMARY KEY,
  last_nudge_at TIMESTAMPTZ,
  recovery_email_sent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE push_cart_nudges ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "service role can manage push_cart_nudges" ON push_cart_nudges
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ─────────────────────────────────────────────
-- 5. NOOD Inbox — notifications history
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_inbox (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
  user_id TEXT,
  device_id TEXT,
  campaign_id TEXT UNIQUE NOT NULL,
  dedupe_key TEXT UNIQUE,
  type TEXT NOT NULL DEFAULT 'general',
  category TEXT,
  priority INTEGER,
  title TEXT NOT NULL DEFAULT 'NOOD',
  body TEXT NOT NULL DEFAULT '',
  route TEXT,
  product_handle TEXT,
  order_id TEXT,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

ALTER TABLE notification_inbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "service role can manage notification_inbox" ON notification_inbox
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

CREATE INDEX IF NOT EXISTS notification_inbox_created_at_idx
  ON notification_inbox (created_at DESC);
CREATE INDEX IF NOT EXISTS notification_inbox_user_id_idx
  ON notification_inbox (user_id);

-- ─────────────────────────────────────────────
-- 6. Notification Inbox Read State (per-user)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_inbox_reads (
  user_id TEXT NOT NULL,
  notification_id UUID NOT NULL REFERENCES notification_inbox (id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, notification_id)
);

ALTER TABLE notification_inbox_reads ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "service role can manage notification_inbox_reads" ON notification_inbox_reads
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ─────────────────────────────────────────────
-- 7. Notification Preferences (per category)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id TEXT NOT NULL,
  category TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, category)
);

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "service role can manage notification_preferences" ON notification_preferences
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ─────────────────────────────────────────────
-- 8. Order Tracking (normalized) — drives tracking screen + inbox + push
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_tracking (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
  shopify_order_id TEXT UNIQUE NOT NULL,
  order_name TEXT,
  email TEXT,
  user_id TEXT,
  carrier TEXT,
  tracking_number TEXT,
  tracking_url TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed',
  friendly_status TEXT,
  latest_event_title TEXT,
  latest_event_description TEXT,
  latest_event_location TEXT,
  latest_event_at TIMESTAMPTZ,
  estimated_delivery TIMESTAMPTZ,
  last_notified_status TEXT,
  tracking_history JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE order_tracking ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "service role can manage order_tracking" ON order_tracking
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

CREATE INDEX IF NOT EXISTS order_tracking_user_id_idx ON order_tracking (user_id);
CREATE INDEX IF NOT EXISTS order_tracking_shopify_order_id_idx ON order_tracking (shopify_order_id);

-- ─────────────────────────────────────────────
-- 9. Orders (from webhooks / order sync)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
  shopify_order_id TEXT UNIQUE,
  email TEXT,
  name TEXT,
  total NUMERIC,
  currency TEXT DEFAULT 'USD',
  status TEXT,
  fulfillment_status TEXT,
  tracking_number TEXT,
  tracking_url TEXT,
  tracking_company TEXT,
  items JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "service role can manage orders" ON orders
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

CREATE INDEX IF NOT EXISTS orders_shopify_order_id_idx ON orders (shopify_order_id);
CREATE INDEX IF NOT EXISTS orders_email_idx ON orders (email);

-- ─────────────────────────────────────────────
-- 9b. Refund/Return Requests
-- ─────────────────────────────────────────────
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

ALTER TABLE refund_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "service role can manage refund_requests" ON refund_requests
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

CREATE INDEX IF NOT EXISTS refund_requests_shopify_order_id_idx ON refund_requests (shopify_order_id);
CREATE INDEX IF NOT EXISTS refund_requests_user_id_idx ON refund_requests (user_id);
CREATE INDEX IF NOT EXISTS refund_requests_customer_email_idx ON refund_requests (customer_email);
CREATE INDEX IF NOT EXISTS refund_requests_status_idx ON refund_requests (status);
CREATE INDEX IF NOT EXISTS refund_requests_request_id_idx ON refund_requests (request_id);

-- ─────────────────────────────────────────────
-- 10. Products (inventory sync + new-product detection)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
  shopify_product_id TEXT UNIQUE,
  title TEXT,
  handle TEXT,
  available_for_sale BOOLEAN DEFAULT TRUE,
  total_inventory INTEGER DEFAULT 0,
  variants JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "service role can manage products" ON products
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

CREATE INDEX IF NOT EXISTS products_shopify_product_id_idx ON products (shopify_product_id);
CREATE INDEX IF NOT EXISTS products_handle_idx ON products (handle);

-- ─────────────────────────────────────────────
-- 11. Carts (abandonment recovery)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS carts (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
  email TEXT UNIQUE,
  profile_id TEXT,
  name TEXT,
  items JSONB DEFAULT '[]',
  recovery_email_sent_at TIMESTAMPTZ,
  recovery_discount_code TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE carts ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "service role can manage carts" ON carts
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

CREATE INDEX IF NOT EXISTS carts_email_idx ON carts (email);
CREATE INDEX IF NOT EXISTS carts_profile_id_idx ON carts (profile_id);

-- ─────────────────────────────────────────────
-- 12. Style Challenges (UGC contests)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS style_challenges (
  id TEXT PRIMARY KEY,
  theme TEXT NOT NULL,
  subtitle TEXT,
  emoji TEXT,
  prize_usd NUMERIC NOT NULL DEFAULT 5,
  ends_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE style_challenges ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "service role can manage style_challenges" ON style_challenges
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY IF NOT EXISTS "public read style_challenges" ON style_challenges
  FOR SELECT USING (TRUE);

CREATE TABLE IF NOT EXISTS challenge_submissions (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
  challenge_id TEXT NOT NULL REFERENCES style_challenges (id),
  user_id TEXT NOT NULL DEFAULT 'guest',
  username TEXT NOT NULL DEFAULT 'nood_user',
  photo_uri TEXT NOT NULL,
  caption TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE challenge_submissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "service role can manage challenge_submissions" ON challenge_submissions
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY IF NOT EXISTS "public read challenge_submissions" ON challenge_submissions
  FOR SELECT USING (TRUE);
CREATE POLICY IF NOT EXISTS "public insert challenge_submissions" ON challenge_submissions
  FOR INSERT WITH CHECK (TRUE);

CREATE INDEX IF NOT EXISTS challenge_submissions_challenge_id_idx
  ON challenge_submissions (challenge_id, created_at DESC);

CREATE TABLE IF NOT EXISTS challenge_votes (
  challenge_id TEXT NOT NULL REFERENCES style_challenges (id),
  submission_id UUID NOT NULL REFERENCES challenge_submissions (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (submission_id, user_id)
);

ALTER TABLE challenge_votes ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "service role can manage challenge_votes" ON challenge_votes
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY IF NOT EXISTS "public read challenge_votes" ON challenge_votes
  FOR SELECT USING (TRUE);
CREATE POLICY IF NOT EXISTS "public insert challenge_votes" ON challenge_votes
  FOR INSERT WITH CHECK (TRUE);
CREATE POLICY IF NOT EXISTS "public delete own vote" ON challenge_votes
  FOR DELETE USING (TRUE);

-- ─────────────────────────────────────────────
-- 13. Video Engagement (likes, comments, shares)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS video_engagement (
  video_id TEXT PRIMARY KEY,
  likes INTEGER NOT NULL DEFAULT 0,
  shares INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE video_engagement ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "service role can manage video_engagement" ON video_engagement
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY IF NOT EXISTS "public read engagement" ON video_engagement
  FOR SELECT USING (TRUE);

CREATE TABLE IF NOT EXISTS video_likes (
  video_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (video_id, user_id)
);

ALTER TABLE video_likes ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "service role can manage video_likes" ON video_likes
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY IF NOT EXISTS "public read likes" ON video_likes
  FOR SELECT USING (TRUE);
CREATE POLICY IF NOT EXISTS "public insert likes" ON video_likes
  FOR INSERT WITH CHECK (TRUE);
CREATE POLICY IF NOT EXISTS "public delete own like" ON video_likes
  FOR DELETE USING (TRUE);

CREATE TABLE IF NOT EXISTS video_comments (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
  video_id TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT 'guest',
  author TEXT NOT NULL DEFAULT 'nood_user',
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE video_comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "service role can manage video_comments" ON video_comments
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY IF NOT EXISTS "public read comments" ON video_comments
  FOR SELECT USING (TRUE);
CREATE POLICY IF NOT EXISTS "public insert comments" ON video_comments
  FOR INSERT WITH CHECK (TRUE);

CREATE INDEX IF NOT EXISTS video_comments_video_id_idx
  ON video_comments (video_id, created_at DESC);

-- Atomic counter increment function (used by the backend to
-- safely +1 / -1 likes and shares under concurrency)
CREATE OR REPLACE FUNCTION increment_engagement(video_id TEXT, col TEXT, delta INT)
RETURNS VOID LANGUAGE PLPGSQL AS $$
BEGIN
  EXECUTE FORMAT(
    'UPDATE video_engagement SET %I = GREATEST(0, %I + $1), updated_at = NOW() WHERE video_id = $2',
    COL, COL
  ) USING delta, video_id;
END $$;

-- ─────────────────────────────────────────────
-- Seed default style challenges (safe to re-run)
-- ─────────────────────────────────────────────
INSERT INTO style_challenges (id, theme, subtitle, emoji, prize_usd, ends_at, active)
VALUES
  ('summer-brunch', 'Summer Brunch', 'Show us your brunch fit', '🍹', 5, NOW() + INTERVAL '7 days', TRUE),
  ('street-style', 'Street Style', 'Your best streetwear look', '🛹', 5, NOW() + INTERVAL '14 days', TRUE),
  ('date-night', 'Date Night', 'Dress to impress', '🌹', 5, NOW() + INTERVAL '21 days', TRUE)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- End of migration
-- ============================================================