-- ============================================================
-- NOOD — Production Supabase Migration (HARDENED, IDEMPOTENT)
-- ============================================================
-- Safety properties:
--   * Every statement is safe to re-run on an EXISTING production DB.
--   * CREATE TABLE IF NOT EXISTS does NOT upgrade pre-existing tables,
--     so every table also gets ALTER TABLE ... ADD COLUMN IF NOT EXISTS
--     for each column the backend expects.
--   * PostgreSQL has NO "CREATE POLICY IF NOT EXISTS". Policies use the
--     DROP POLICY IF EXISTS + CREATE POLICY pattern (fully idempotent).
--   * The backend writes through the SUPABASE_SERVICE_ROLE_KEY client
--     (utils/supabase.js), which BYPASSES RLS. Public/anonymous INSERT and
--     DELETE policies are therefore REMOVED — they allowed arbitrary
--     user_id impersonation and arbitrary vote/like deletion.
--   * Public SELECT is kept ONLY on genuinely public content tables
--     (style_challenges, video_engagement, video_comments).
--   * NO destructive statements: no DROP TABLE, DROP COLUMN, TRUNCATE,
--     or unsafe DELETE anywhere in this file.
-- ============================================================

-- ============================================================
-- 1. Push Notification Tokens
-- ============================================================
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

-- Upgrade a pre-existing table (CREATE TABLE IF NOT EXISTS is a no-op there).
ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS token TEXT;
ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS platform TEXT DEFAULT 'android';
ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS device_id TEXT;
ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS app_version TEXT;
ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE push_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage push_tokens" ON push_tokens;
CREATE POLICY "service role can manage push_tokens" ON push_tokens
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ============================================================
-- 2. Push Campaign Events (dedupe + stats)
-- ============================================================
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

ALTER TABLE push_campaign_events ADD COLUMN IF NOT EXISTS id UUID;
ALTER TABLE push_campaign_events ADD COLUMN IF NOT EXISTS campaign_id TEXT;
ALTER TABLE push_campaign_events ADD COLUMN IF NOT EXISTS campaign_type TEXT NOT NULL DEFAULT 'general';
ALTER TABLE push_campaign_events ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
ALTER TABLE push_campaign_events ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE push_campaign_events ADD COLUMN IF NOT EXISTS body TEXT;
ALTER TABLE push_campaign_events ADD COLUMN IF NOT EXISTS payload JSONB DEFAULT '{}';
ALTER TABLE push_campaign_events ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'created';
ALTER TABLE push_campaign_events ADD COLUMN IF NOT EXISTS recipient_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE push_campaign_events ADD COLUMN IF NOT EXISTS sent_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE push_campaign_events ADD COLUMN IF NOT EXISTS failed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE push_campaign_events ADD COLUMN IF NOT EXISTS skipped_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE push_campaign_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE push_campaign_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage push_campaign_events" ON push_campaign_events;
CREATE POLICY "service role can manage push_campaign_events" ON push_campaign_events
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

CREATE INDEX IF NOT EXISTS push_campaign_events_dedupe_key_idx
  ON push_campaign_events (dedupe_key);

-- ============================================================
-- 3. Push Frequency (per-token, per-day + user_id)
-- ============================================================
CREATE TABLE IF NOT EXISTS push_frequency (
  token TEXT NOT NULL,
  day TEXT NOT NULL,
  user_id TEXT,
  promo_count INTEGER NOT NULL DEFAULT 0,
  last_promo_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (token, day)
);

ALTER TABLE push_frequency ADD COLUMN IF NOT EXISTS token TEXT;
ALTER TABLE push_frequency ADD COLUMN IF NOT EXISTS day TEXT;
ALTER TABLE push_frequency ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE push_frequency ADD COLUMN IF NOT EXISTS promo_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE push_frequency ADD COLUMN IF NOT EXISTS last_promo_at TIMESTAMPTZ;
ALTER TABLE push_frequency ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE push_frequency ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage push_frequency" ON push_frequency;
CREATE POLICY "service role can manage push_frequency" ON push_frequency
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ============================================================
-- 4. Push Cart Nudges (cooldown)
-- ============================================================
CREATE TABLE IF NOT EXISTS push_cart_nudges (
  cart_key TEXT PRIMARY KEY,
  last_nudge_at TIMESTAMPTZ,
  recovery_email_sent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE push_cart_nudges ADD COLUMN IF NOT EXISTS cart_key TEXT;
ALTER TABLE push_cart_nudges ADD COLUMN IF NOT EXISTS last_nudge_at TIMESTAMPTZ;
ALTER TABLE push_cart_nudges ADD COLUMN IF NOT EXISTS recovery_email_sent_at TIMESTAMPTZ;
ALTER TABLE push_cart_nudges ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE push_cart_nudges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage push_cart_nudges" ON push_cart_nudges;
CREATE POLICY "service role can manage push_cart_nudges" ON push_cart_nudges
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ============================================================
-- 5. NOOD Inbox — notifications history
--    NOTE: backend (utils/inbox-db.js) reads/writes a `campaign`
--    column. It was MISSING from prior schemas — added here so
--    Supabase inserts stop falling back to JSON files.
-- ============================================================
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
  campaign TEXT,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

ALTER TABLE notification_inbox ADD COLUMN IF NOT EXISTS id UUID;
ALTER TABLE notification_inbox ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE notification_inbox ADD COLUMN IF NOT EXISTS device_id TEXT;
ALTER TABLE notification_inbox ADD COLUMN IF NOT EXISTS campaign_id TEXT;
ALTER TABLE notification_inbox ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
ALTER TABLE notification_inbox ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'general';
ALTER TABLE notification_inbox ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE notification_inbox ADD COLUMN IF NOT EXISTS priority INTEGER;
ALTER TABLE notification_inbox ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT 'NOOD';
ALTER TABLE notification_inbox ADD COLUMN IF NOT EXISTS body TEXT NOT NULL DEFAULT '';
ALTER TABLE notification_inbox ADD COLUMN IF NOT EXISTS route TEXT;
ALTER TABLE notification_inbox ADD COLUMN IF NOT EXISTS product_handle TEXT;
ALTER TABLE notification_inbox ADD COLUMN IF NOT EXISTS order_id TEXT;
ALTER TABLE notification_inbox ADD COLUMN IF NOT EXISTS campaign TEXT;
ALTER TABLE notification_inbox ADD COLUMN IF NOT EXISTS data JSONB DEFAULT '{}';
ALTER TABLE notification_inbox ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE notification_inbox ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

ALTER TABLE notification_inbox ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage notification_inbox" ON notification_inbox;
CREATE POLICY "service role can manage notification_inbox" ON notification_inbox
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

CREATE INDEX IF NOT EXISTS notification_inbox_created_at_idx
  ON notification_inbox (created_at DESC);
CREATE INDEX IF NOT EXISTS notification_inbox_user_id_idx
  ON notification_inbox (user_id);

-- ============================================================
-- 6. Notification Inbox Read State (per-user)
-- ============================================================
CREATE TABLE IF NOT EXISTS notification_inbox_reads (
  user_id TEXT NOT NULL,
  notification_id UUID NOT NULL REFERENCES notification_inbox (id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, notification_id)
);

ALTER TABLE notification_inbox_reads ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE notification_inbox_reads ADD COLUMN IF NOT EXISTS notification_id UUID;
ALTER TABLE notification_inbox_reads ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE notification_inbox_reads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage notification_inbox_reads" ON notification_inbox_reads;
CREATE POLICY "service role can manage notification_inbox_reads" ON notification_inbox_reads
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ============================================================
-- 7. Notification Preferences (per category)
-- ============================================================
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id TEXT NOT NULL,
  category TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, category)
);

ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage notification_preferences" ON notification_preferences;
CREATE POLICY "service role can manage notification_preferences" ON notification_preferences
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ============================================================
-- 8. Order Tracking (normalized) — drives tracking screen + inbox + push
-- ============================================================
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

ALTER TABLE order_tracking ADD COLUMN IF NOT EXISTS id UUID;
ALTER TABLE order_tracking ADD COLUMN IF NOT EXISTS shopify_order_id TEXT;
ALTER TABLE order_tracking ADD COLUMN IF NOT EXISTS order_name TEXT;
ALTER TABLE order_tracking ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE order_tracking ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE order_tracking ADD COLUMN IF NOT EXISTS carrier TEXT;
ALTER TABLE order_tracking ADD COLUMN IF NOT EXISTS tracking_number TEXT;
ALTER TABLE order_tracking ADD COLUMN IF NOT EXISTS tracking_url TEXT;
ALTER TABLE order_tracking ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'confirmed';
ALTER TABLE order_tracking ADD COLUMN IF NOT EXISTS friendly_status TEXT;
ALTER TABLE order_tracking ADD COLUMN IF NOT EXISTS latest_event_title TEXT;
ALTER TABLE order_tracking ADD COLUMN IF NOT EXISTS latest_event_description TEXT;
ALTER TABLE order_tracking ADD COLUMN IF NOT EXISTS latest_event_location TEXT;
ALTER TABLE order_tracking ADD COLUMN IF NOT EXISTS latest_event_at TIMESTAMPTZ;
ALTER TABLE order_tracking ADD COLUMN IF NOT EXISTS estimated_delivery TIMESTAMPTZ;
ALTER TABLE order_tracking ADD COLUMN IF NOT EXISTS last_notified_status TEXT;
ALTER TABLE order_tracking ADD COLUMN IF NOT EXISTS tracking_history JSONB DEFAULT '[]';
ALTER TABLE order_tracking ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE order_tracking ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE order_tracking ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage order_tracking" ON order_tracking;
CREATE POLICY "service role can manage order_tracking" ON order_tracking
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

CREATE INDEX IF NOT EXISTS order_tracking_user_id_idx ON order_tracking (user_id);
CREATE INDEX IF NOT EXISTS order_tracking_shopify_order_id_idx ON order_tracking (shopify_order_id);

-- ============================================================
-- 9. Orders (from webhooks / order sync)
--    NOTE: user_id column added so future order rows can bind
--    ownership; refunds route falls back to order_tracking when
--    this table has no row.
-- ============================================================
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
  shopify_order_id TEXT UNIQUE,
  email TEXT,
  user_id TEXT,
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

ALTER TABLE orders ADD COLUMN IF NOT EXISTS id UUID;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shopify_order_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS total NUMERIC;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_status TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_url TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_company TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS items JSONB DEFAULT '[]';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage orders" ON orders;
CREATE POLICY "service role can manage orders" ON orders
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

CREATE INDEX IF NOT EXISTS orders_shopify_order_id_idx ON orders (shopify_order_id);
CREATE INDEX IF NOT EXISTS orders_email_idx ON orders (email);

-- ============================================================
-- 9b. Refund/Return Requests
-- ============================================================
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
-- 10. Products (inventory sync + new-product detection)
-- ============================================================
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

ALTER TABLE products ADD COLUMN IF NOT EXISTS id UUID;
ALTER TABLE products ADD COLUMN IF NOT EXISTS shopify_product_id TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS handle TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS available_for_sale BOOLEAN DEFAULT TRUE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS total_inventory INTEGER DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS variants JSONB DEFAULT '[]';
ALTER TABLE products ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE products ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage products" ON products;
CREATE POLICY "service role can manage products" ON products
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

CREATE INDEX IF NOT EXISTS products_shopify_product_id_idx ON products (shopify_product_id);
CREATE INDEX IF NOT EXISTS products_handle_idx ON products (handle);

-- ============================================================
-- 11. Carts (abandonment recovery)
-- ============================================================
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

ALTER TABLE carts ADD COLUMN IF NOT EXISTS id UUID;
ALTER TABLE carts ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE carts ADD COLUMN IF NOT EXISTS profile_id TEXT;
ALTER TABLE carts ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE carts ADD COLUMN IF NOT EXISTS items JSONB DEFAULT '[]';
ALTER TABLE carts ADD COLUMN IF NOT EXISTS recovery_email_sent_at TIMESTAMPTZ;
ALTER TABLE carts ADD COLUMN IF NOT EXISTS recovery_discount_code TEXT;
ALTER TABLE carts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE carts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage carts" ON carts;
CREATE POLICY "service role can manage carts" ON carts
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

CREATE INDEX IF NOT EXISTS carts_email_idx ON carts (email);
CREATE INDEX IF NOT EXISTS carts_profile_id_idx ON carts (profile_id);

-- ============================================================
-- 12. Style Challenges (UGC contests)
--     PUBLIC READ only (public contest listing). All writes go
--     through the backend service-role client.
-- ============================================================
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

ALTER TABLE style_challenges ADD COLUMN IF NOT EXISTS id TEXT;
ALTER TABLE style_challenges ADD COLUMN IF NOT EXISTS theme TEXT;
ALTER TABLE style_challenges ADD COLUMN IF NOT EXISTS subtitle TEXT;
ALTER TABLE style_challenges ADD COLUMN IF NOT EXISTS emoji TEXT;
ALTER TABLE style_challenges ADD COLUMN IF NOT EXISTS prize_usd NUMERIC NOT NULL DEFAULT 5;
ALTER TABLE style_challenges ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ;
ALTER TABLE style_challenges ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE style_challenges ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE style_challenges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage style_challenges" ON style_challenges;
CREATE POLICY "service role can manage style_challenges" ON style_challenges
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
DROP POLICY IF EXISTS "public read style_challenges" ON style_challenges;
CREATE POLICY "public read style_challenges" ON style_challenges
  FOR SELECT USING (TRUE);

-- Submissions: SERVICE-ROLE ONLY.
-- Previously exposed "public insert/read" — removed (backend owns writes,
-- and rows expose user_id + photo_uri).
CREATE TABLE IF NOT EXISTS challenge_submissions (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
  challenge_id TEXT NOT NULL REFERENCES style_challenges (id),
  user_id TEXT NOT NULL DEFAULT 'guest',
  username TEXT NOT NULL DEFAULT 'nood_user',
  photo_uri TEXT NOT NULL,
  caption TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE challenge_submissions ADD COLUMN IF NOT EXISTS id UUID;
ALTER TABLE challenge_submissions ADD COLUMN IF NOT EXISTS challenge_id TEXT;
ALTER TABLE challenge_submissions ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT 'guest';
ALTER TABLE challenge_submissions ADD COLUMN IF NOT EXISTS username TEXT NOT NULL DEFAULT 'nood_user';
ALTER TABLE challenge_submissions ADD COLUMN IF NOT EXISTS photo_uri TEXT;
ALTER TABLE challenge_submissions ADD COLUMN IF NOT EXISTS caption TEXT;
ALTER TABLE challenge_submissions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE challenge_submissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage challenge_submissions" ON challenge_submissions;
CREATE POLICY "service role can manage challenge_submissions" ON challenge_submissions
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
-- Remove previously-created public access (from earlier migration drafts).
DROP POLICY IF EXISTS "public read challenge_submissions" ON challenge_submissions;
DROP POLICY IF EXISTS "public insert challenge_submissions" ON challenge_submissions;

CREATE INDEX IF NOT EXISTS challenge_submissions_challenge_id_idx
  ON challenge_submissions (challenge_id, created_at DESC);

-- Votes: SERVICE-ROLE ONLY. No anonymous insert/delete.
CREATE TABLE IF NOT EXISTS challenge_votes (
  challenge_id TEXT NOT NULL REFERENCES style_challenges (id),
  submission_id UUID NOT NULL REFERENCES challenge_submissions (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (submission_id, user_id)
);

ALTER TABLE challenge_votes ADD COLUMN IF NOT EXISTS challenge_id TEXT;
ALTER TABLE challenge_votes ADD COLUMN IF NOT EXISTS submission_id UUID;
ALTER TABLE challenge_votes ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE challenge_votes ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE challenge_votes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage challenge_votes" ON challenge_votes;
CREATE POLICY "service role can manage challenge_votes" ON challenge_votes
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
-- Remove previously-created public access (from earlier migration drafts).
DROP POLICY IF EXISTS "public read challenge_votes" ON challenge_votes;
DROP POLICY IF EXISTS "public insert challenge_votes" ON challenge_votes;
DROP POLICY IF EXISTS "public delete own vote" ON challenge_votes;

-- ============================================================
-- 12b. Notification Analytics (lightweight event tracking)
-- ============================================================
CREATE TABLE IF NOT EXISTS notification_analytics (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
  event TEXT NOT NULL,
  type TEXT,
  category TEXT,
  campaign_id TEXT,
  token_suffix TEXT,
  count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE notification_analytics ADD COLUMN IF NOT EXISTS id UUID;
ALTER TABLE notification_analytics ADD COLUMN IF NOT EXISTS event TEXT;
ALTER TABLE notification_analytics ADD COLUMN IF NOT EXISTS type TEXT;
ALTER TABLE notification_analytics ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE notification_analytics ADD COLUMN IF NOT EXISTS campaign_id TEXT;
ALTER TABLE notification_analytics ADD COLUMN IF NOT EXISTS token_suffix TEXT;
ALTER TABLE notification_analytics ADD COLUMN IF NOT EXISTS count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notification_analytics ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE notification_analytics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage notification_analytics" ON notification_analytics;
CREATE POLICY "service role can manage notification_analytics" ON notification_analytics
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

CREATE INDEX IF NOT EXISTS notification_analytics_created_at_idx
  ON notification_analytics (created_at DESC);
CREATE INDEX IF NOT EXISTS notification_analytics_event_idx
  ON notification_analytics (event);

-- ============================================================
-- 13. Video Engagement (likes, comments, shares)
--     PUBLIC READ ONLY on counts + comments (public feed content).
--     Likes writes (insert/delete) are backend-only.
-- ============================================================
CREATE TABLE IF NOT EXISTS video_engagement (
  video_id TEXT PRIMARY KEY,
  likes INTEGER NOT NULL DEFAULT 0,
  shares INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE video_engagement ADD COLUMN IF NOT EXISTS video_id TEXT;
ALTER TABLE video_engagement ADD COLUMN IF NOT EXISTS likes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE video_engagement ADD COLUMN IF NOT EXISTS shares INTEGER NOT NULL DEFAULT 0;
ALTER TABLE video_engagement ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE video_engagement ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage video_engagement" ON video_engagement;
CREATE POLICY "service role can manage video_engagement" ON video_engagement
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
DROP POLICY IF EXISTS "public read engagement" ON video_engagement;
CREATE POLICY "public read engagement" ON video_engagement
  FOR SELECT USING (TRUE);

-- Likes: SERVICE-ROLE ONLY. No anonymous insert/delete of likes.
CREATE TABLE IF NOT EXISTS video_likes (
  video_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (video_id, user_id)
);

ALTER TABLE video_likes ADD COLUMN IF NOT EXISTS video_id TEXT;
ALTER TABLE video_likes ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE video_likes ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE video_likes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage video_likes" ON video_likes;
CREATE POLICY "service role can manage video_likes" ON video_likes
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
-- Remove previously-created public access (from earlier migration drafts).
DROP POLICY IF EXISTS "public read likes" ON video_likes;
DROP POLICY IF EXISTS "public insert likes" ON video_likes;
DROP POLICY IF EXISTS "public delete own like" ON video_likes;

-- Comments: PUBLIC READ ONLY (public comment feed). Writes via backend.
CREATE TABLE IF NOT EXISTS video_comments (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
  video_id TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT 'guest',
  author TEXT NOT NULL DEFAULT 'nood_user',
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE video_comments ADD COLUMN IF NOT EXISTS id UUID;
ALTER TABLE video_comments ADD COLUMN IF NOT EXISTS video_id TEXT;
ALTER TABLE video_comments ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT 'guest';
ALTER TABLE video_comments ADD COLUMN IF NOT EXISTS author TEXT NOT NULL DEFAULT 'nood_user';
ALTER TABLE video_comments ADD COLUMN IF NOT EXISTS body TEXT;
ALTER TABLE video_comments ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE video_comments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage video_comments" ON video_comments;
CREATE POLICY "service role can manage video_comments" ON video_comments
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
DROP POLICY IF EXISTS "public read comments" ON video_comments;
CREATE POLICY "public read comments" ON video_comments
  FOR SELECT USING (TRUE);
-- Remove previously-created public write access.
DROP POLICY IF EXISTS "public insert comments" ON video_comments;

CREATE INDEX IF NOT EXISTS video_comments_video_id_idx
  ON video_comments (video_id, created_at DESC);

-- ============================================================
-- Atomic counter increment function (idempotent by definition)
-- ============================================================
CREATE OR REPLACE FUNCTION increment_engagement(video_id TEXT, col TEXT, delta INT)
RETURNS VOID LANGUAGE PLPGSQL AS $$
BEGIN
  EXECUTE FORMAT(
    'UPDATE video_engagement SET %I = GREATEST(0, %I + $1), updated_at = NOW() WHERE video_id = $2',
    COL, COL
  ) USING delta, video_id;
END $$;

-- ============================================================
-- Seed default style challenges (safe to re-run)
-- ============================================================
INSERT INTO style_challenges (id, theme, subtitle, emoji, prize_usd, ends_at, active)
VALUES
  ('summer-brunch', 'Summer Brunch', 'Show us your brunch fit', '🍹', 5, NOW() + INTERVAL '7 days', TRUE),
  ('street-style', 'Street Style', 'Your best streetwear look', '🛹', 5, NOW() + INTERVAL '14 days', TRUE),
  ('date-night', 'Date Night', 'Dress to impress', '🌹', 5, NOW() + INTERVAL '21 days', TRUE)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- End of migration
-- ============================================================
