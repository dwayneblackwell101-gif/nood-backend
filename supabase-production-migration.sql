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
  payment_provider TEXT,
  payment_transaction_id TEXT,
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
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_provider TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_transaction_id TEXT;
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
-- 12c. Wishlist Items (backend-persisted, per-user)
--     Enables server-side wishlist triggers (price-drop / restock /
--     low-stock) with price snapshots for drop detection.
--     identity: user_id (bound to push token) OR customer email.
-- ============================================================
CREATE TABLE IF NOT EXISTS wishlist_items (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
  user_id TEXT,
  email TEXT,
  handle TEXT NOT NULL,
  product_id TEXT,
  variant_id TEXT,
  title TEXT,
  image TEXT,
  price NUMERIC,
  currency TEXT DEFAULT 'USD',
  size TEXT,
  color TEXT,
  notified_price NUMERIC,
  notified_restock BOOLEAN NOT NULL DEFAULT FALSE,
  notified_low_stock BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, handle)
);

ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS id UUID;
ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS handle TEXT;
ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS product_id TEXT;
ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS variant_id TEXT;
ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS image TEXT;
ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS price NUMERIC;
ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD';
ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS size TEXT;
ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS color TEXT;
ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS notified_price NUMERIC;
ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS notified_restock BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS notified_low_stock BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE wishlist_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage wishlist_items" ON wishlist_items;
CREATE POLICY "service role can manage wishlist_items" ON wishlist_items
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

CREATE INDEX IF NOT EXISTS wishlist_items_user_id_idx ON wishlist_items (user_id);
CREATE INDEX IF NOT EXISTS wishlist_items_email_idx ON wishlist_items (email);
CREATE INDEX IF NOT EXISTS wishlist_items_handle_idx ON wishlist_items (handle);

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

CREATE TABLE IF NOT EXISTS video_reports (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(), video_id TEXT NOT NULL, user_id TEXT NOT NULL,
  reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(video_id, user_id)
);
ALTER TABLE video_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage video_reports" ON video_reports;
CREATE POLICY "service role can manage video_reports" ON video_reports FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

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
-- 14. Reward Ledger (immutable, server-authoritative)
--     Every reward/credit transaction. Balance is DERIVED by summing
--     this ledger — never from client state.
--     idempotency_key UNIQUE prevents replay.
-- ============================================================
CREATE TABLE IF NOT EXISTS reward_ledger (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
  transaction_id TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,                -- credit | debit | reversal | expire
  source TEXT NOT NULL,              -- referral | loyalty | order | admin | bonus
  amount NUMERIC NOT NULL,           -- positive for credit, negative for debit/expire
  currency TEXT NOT NULL DEFAULT 'USD',
  points INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'issued',  -- issued | redeemed | expired | reversed
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  redeemed_at TIMESTAMPTZ,
  related_id TEXT,                   -- referral/order/challenge id
  idempotency_key TEXT UNIQUE NOT NULL,
  metadata JSONB DEFAULT '{}'
);

ALTER TABLE reward_ledger ADD COLUMN IF NOT EXISTS id UUID;
ALTER TABLE reward_ledger ADD COLUMN IF NOT EXISTS transaction_id TEXT;
ALTER TABLE reward_ledger ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE reward_ledger ADD COLUMN IF NOT EXISTS type TEXT;
ALTER TABLE reward_ledger ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE reward_ledger ADD COLUMN IF NOT EXISTS amount NUMERIC;
ALTER TABLE reward_ledger ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE reward_ledger ADD COLUMN IF NOT EXISTS points INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reward_ledger ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'issued';
ALTER TABLE reward_ledger ADD COLUMN IF NOT EXISTS issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE reward_ledger ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE reward_ledger ADD COLUMN IF NOT EXISTS redeemed_at TIMESTAMPTZ;
ALTER TABLE reward_ledger ADD COLUMN IF NOT EXISTS related_id TEXT;
ALTER TABLE reward_ledger ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE reward_ledger ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

ALTER TABLE reward_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage reward_ledger" ON reward_ledger;
CREATE POLICY "service role can manage reward_ledger" ON reward_ledger
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

CREATE INDEX IF NOT EXISTS reward_ledger_user_id_idx ON reward_ledger (user_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS reward_ledger_idempotency_idx ON reward_ledger (idempotency_key);
CREATE INDEX IF NOT EXISTS reward_ledger_status_idx ON reward_ledger (status, expires_at);

-- ============================================================
-- 15. Wallet Transactions (authoritative debit/credit history)
-- ============================================================
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
  txn_id TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,               -- credit | debit | reversal | expire
  source TEXT NOT NULL,             -- topup | reward | order_payment | referral | admin | reversal
  amount NUMERIC NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  balance_after NUMERIC NOT NULL DEFAULT 0,
  reference TEXT,
  idempotency_key TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}',
  reverses_transaction_id TEXT      -- links to the transaction_id being reversed (for reversal type)
);

-- Add reversal linkage column if not exists
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS reverses_transaction_id TEXT;

ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS id UUID;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS txn_id TEXT;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS type TEXT;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS amount NUMERIC;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS balance_after NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS reference TEXT;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage wallet_transactions" ON wallet_transactions;
CREATE POLICY "service role can manage wallet_transactions" ON wallet_transactions
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

CREATE INDEX IF NOT EXISTS wallet_transactions_user_idx ON wallet_transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wallet_transactions_idempotency_idx ON wallet_transactions (idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_idempotency_unique_idx
  ON wallet_transactions (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Serializes each user's wallet writes and performs the balance check plus
-- insert in one transaction. The service-role backend is the only caller.
CREATE OR REPLACE FUNCTION apply_wallet_transaction_atomic(
  p_user_id TEXT,
  p_amount NUMERIC,
  p_currency TEXT,
  p_type TEXT,
  p_source TEXT,
  p_reference TEXT,
  p_idempotency_key TEXT,
  p_metadata JSONB DEFAULT '{}'::JSONB,
  p_reverses_transaction_id TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  existing wallet_transactions%ROWTYPE;
  current_balance NUMERIC := 0;
  next_balance NUMERIC := 0;
  new_txn_id TEXT;
BEGIN
  IF p_user_id IS NULL OR BTRIM(p_user_id) = '' OR p_amount IS NULL OR p_idempotency_key IS NULL THEN
    RETURN JSONB_BUILD_OBJECT('ok', FALSE, 'error', 'invalid_txn');
  END IF;

  PERFORM PG_ADVISORY_XACT_LOCK(HASHTEXT('nood_wallet:' || p_user_id));

  SELECT * INTO existing FROM wallet_transactions
    WHERE idempotency_key = p_idempotency_key LIMIT 1;
  IF FOUND THEN
    RETURN JSONB_BUILD_OBJECT('ok', FALSE, 'replay', TRUE, 'balance', existing.balance_after, 'txnId', existing.txn_id);
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO current_balance
    FROM wallet_transactions WHERE user_id = p_user_id AND currency = p_currency;
  next_balance := current_balance + p_amount;
  IF next_balance < 0 THEN
    RETURN JSONB_BUILD_OBJECT('ok', FALSE, 'error', 'insufficient_balance', 'balance', current_balance);
  END IF;

  new_txn_id := 'txn_' || REPLACE(GEN_RANDOM_UUID()::TEXT, '-', '');
  INSERT INTO wallet_transactions (
    txn_id, user_id, type, source, amount, currency, balance_after,
    reference, idempotency_key, metadata, reverses_transaction_id
  ) VALUES (
    new_txn_id, p_user_id, p_type, p_source, p_amount, p_currency, next_balance,
    p_reference, p_idempotency_key, COALESCE(p_metadata, '{}'::JSONB), p_reverses_transaction_id
  );

  RETURN JSONB_BUILD_OBJECT('ok', TRUE, 'balance', next_balance, 'txnId', new_txn_id);
END $$;

REVOKE ALL ON FUNCTION apply_wallet_transaction_atomic(TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_wallet_transaction_atomic(TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION issue_reward_atomic(
  p_user_id TEXT,
  p_source TEXT,
  p_amount NUMERIC,
  p_currency TEXT,
  p_points INTEGER,
  p_related_id TEXT,
  p_idempotency_key TEXT,
  p_expires_at TIMESTAMPTZ,
  p_metadata JSONB,
  p_max_prize NUMERIC,
  p_user_daily_limit NUMERIC,
  p_user_monthly_limit NUMERIC,
  p_global_daily_budget NUMERIC
) RETURNS JSONB
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  existing reward_ledger%ROWTYPE;
  daily_total NUMERIC := 0;
  monthly_total NUMERIC := 0;
  global_total NUMERIC := 0;
  wallet_balance NUMERIC := 0;
  reward_txn_id TEXT;
  wallet_txn_id TEXT;
BEGIN
  IF p_user_id IS NULL OR BTRIM(p_user_id) = '' OR p_amount IS NULL OR p_amount < 0 OR p_amount > p_max_prize THEN
    RETURN JSONB_BUILD_OBJECT('ok', FALSE, 'error', 'reward_limit_exceeded');
  END IF;
  PERFORM PG_ADVISORY_XACT_LOCK(HASHTEXT('nood_wallet:' || p_user_id));
  SELECT * INTO existing FROM reward_ledger WHERE idempotency_key = p_idempotency_key LIMIT 1;
  IF FOUND THEN
    RETURN JSONB_BUILD_OBJECT('ok', FALSE, 'existing', TRUE, 'replay', TRUE, 'transactionId', existing.transaction_id);
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO daily_total FROM reward_ledger
    WHERE user_id = p_user_id AND type = 'credit' AND status <> 'reversed' AND issued_at >= DATE_TRUNC('day', NOW());
  SELECT COALESCE(SUM(amount), 0) INTO monthly_total FROM reward_ledger
    WHERE user_id = p_user_id AND type = 'credit' AND status <> 'reversed' AND issued_at >= DATE_TRUNC('month', NOW());
  SELECT COALESCE(SUM(amount), 0) INTO global_total FROM reward_ledger
    WHERE type = 'credit' AND status <> 'reversed' AND issued_at >= DATE_TRUNC('day', NOW());
  IF daily_total + p_amount > p_user_daily_limit OR monthly_total + p_amount > p_user_monthly_limit OR global_total + p_amount > p_global_daily_budget THEN
    RETURN JSONB_BUILD_OBJECT('ok', FALSE, 'error', 'reward_budget_exceeded');
  END IF;

  reward_txn_id := 'txn_' || REPLACE(GEN_RANDOM_UUID()::TEXT, '-', '');
  INSERT INTO reward_ledger (transaction_id, user_id, type, source, amount, currency, points,
    status, expires_at, related_id, idempotency_key, metadata)
  VALUES (reward_txn_id, p_user_id, 'credit', p_source, p_amount, p_currency, COALESCE(p_points, 0),
    'issued', p_expires_at, p_related_id, p_idempotency_key, COALESCE(p_metadata, '{}'::JSONB));

  SELECT COALESCE(SUM(amount), 0) INTO wallet_balance FROM wallet_transactions
    WHERE user_id = p_user_id AND currency = p_currency;
  wallet_balance := wallet_balance + p_amount;
  wallet_txn_id := 'txn_' || REPLACE(GEN_RANDOM_UUID()::TEXT, '-', '');
  INSERT INTO wallet_transactions (txn_id, user_id, type, source, amount, currency, balance_after,
    reference, idempotency_key, metadata)
  VALUES (wallet_txn_id, p_user_id, 'credit', 'reward_' || p_source, p_amount, p_currency, wallet_balance,
    reward_txn_id, 'reward-wallet:' || p_idempotency_key,
    JSONB_BUILD_OBJECT('rewardTransactionId', reward_txn_id));
  RETURN JSONB_BUILD_OBJECT('ok', TRUE, 'transactionId', reward_txn_id,
    'walletTxnId', wallet_txn_id, 'balance', wallet_balance);
END $$;

REVOKE ALL ON FUNCTION issue_reward_atomic(TEXT, TEXT, NUMERIC, TEXT, INTEGER, TEXT, TEXT, TIMESTAMPTZ, JSONB, NUMERIC, NUMERIC, NUMERIC, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION issue_reward_atomic(TEXT, TEXT, NUMERIC, TEXT, INTEGER, TEXT, TEXT, TIMESTAMPTZ, JSONB, NUMERIC, NUMERIC, NUMERIC, NUMERIC) TO service_role;

-- Durable PayPal/wallet state. It survives deploys and makes capture retries
-- idempotent even when Render restarts between create and capture.
CREATE TABLE IF NOT EXISTS payment_sessions (
  provider_order_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  user_id TEXT,
  status TEXT NOT NULL,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  cart JSONB NOT NULL,
  customer JSONB DEFAULT '{}'::JSONB,
  shipping_address JSONB DEFAULT '{}'::JSONB,
  shopify_order JSONB,
  capture_id TEXT,
  wallet_transaction_id TEXT,
  wallet_balance NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE payment_sessions ADD COLUMN IF NOT EXISTS wallet_transaction_id TEXT;
ALTER TABLE payment_sessions ADD COLUMN IF NOT EXISTS wallet_balance NUMERIC;
ALTER TABLE payment_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage payment_sessions" ON payment_sessions;
CREATE POLICY "service role can manage payment_sessions" ON payment_sessions
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
-- ============================================================
-- 20. Referral Records (durable Supabase persistence)
-- ============================================================
CREATE TABLE IF NOT EXISTS referral_codes (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
  code TEXT UNIQUE NOT NULL,
  owner_user_id TEXT UNIQUE NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE referral_codes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage referral_codes" ON referral_codes;
CREATE POLICY "service role can manage referral_codes" ON referral_codes
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

CREATE TABLE IF NOT EXISTS referral_records (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
  referral_code TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  referred_user_id TEXT,
  referred_email TEXT,
  status TEXT NOT NULL DEFAULT 'invited',  -- invited | joined | qualified | rewarded
  qualified_at TIMESTAMPTZ,
  rewarded_at TIMESTAMPTZ,
  reward_amount NUMERIC NOT NULL DEFAULT 10,
  reward_currency TEXT NOT NULL DEFAULT 'USD',
  idempotency_key TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner_user_id, referred_user_id)
);

ALTER TABLE referral_records ADD COLUMN IF NOT EXISTS id UUID;
ALTER TABLE referral_records ADD COLUMN IF NOT EXISTS referral_code TEXT;
ALTER TABLE referral_records ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
ALTER TABLE referral_records ADD COLUMN IF NOT EXISTS referred_user_id TEXT;
ALTER TABLE referral_records ADD COLUMN IF NOT EXISTS referred_email TEXT;
ALTER TABLE referral_records ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'invited';
ALTER TABLE referral_records ADD COLUMN IF NOT EXISTS qualified_at TIMESTAMPTZ;
ALTER TABLE referral_records ADD COLUMN IF NOT EXISTS rewarded_at TIMESTAMPTZ;
ALTER TABLE referral_records ADD COLUMN IF NOT EXISTS reward_amount NUMERIC NOT NULL DEFAULT 10;
ALTER TABLE referral_records ADD COLUMN IF NOT EXISTS reward_currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE referral_records ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE referral_records ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE referral_records ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE referral_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage referral_records" ON referral_records;
CREATE POLICY "service role can manage referral_records" ON referral_records
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

CREATE INDEX IF NOT EXISTS referral_records_owner_idx ON referral_records (owner_user_id);
CREATE INDEX IF NOT EXISTS referral_records_code_idx ON referral_records (referral_code);
CREATE INDEX IF NOT EXISTS referral_records_referred_idx ON referral_records (referred_user_id);

-- ============================================================
-- 21. Loyalty State (tiers, milestones)
-- ============================================================
CREATE TABLE IF NOT EXISTS loyalty_state (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
  user_id TEXT UNIQUE NOT NULL,
  tier TEXT NOT NULL DEFAULT 'member',   -- member | bronze | silver | gold | vip
  tier_points INTEGER NOT NULL DEFAULT 0,
  lifetime_points INTEGER NOT NULL DEFAULT 0,
  progress INTEGER NOT NULL DEFAULT 0,
  next_tier TEXT,
  tier_changed_at TIMESTAMPTZ,
  milestone_history JSONB DEFAULT '[]',
  birthday_reward_at TIMESTAMPTZ,
  anniversary_reward_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE loyalty_state ADD COLUMN IF NOT EXISTS id UUID;
ALTER TABLE loyalty_state ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE loyalty_state ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'member';
ALTER TABLE loyalty_state ADD COLUMN IF NOT EXISTS tier_points INTEGER NOT NULL DEFAULT 0;
ALTER TABLE loyalty_state ADD COLUMN IF NOT EXISTS lifetime_points INTEGER NOT NULL DEFAULT 0;
ALTER TABLE loyalty_state ADD COLUMN IF NOT EXISTS progress INTEGER NOT NULL DEFAULT 0;
ALTER TABLE loyalty_state ADD COLUMN IF NOT EXISTS next_tier TEXT;
ALTER TABLE loyalty_state ADD COLUMN IF NOT EXISTS tier_changed_at TIMESTAMPTZ;
ALTER TABLE loyalty_state ADD COLUMN IF NOT EXISTS milestone_history JSONB DEFAULT '[]';
ALTER TABLE loyalty_state ADD COLUMN IF NOT EXISTS birthday_reward_at TIMESTAMPTZ;
ALTER TABLE loyalty_state ADD COLUMN IF NOT EXISTS anniversary_reward_at TIMESTAMPTZ;
ALTER TABLE loyalty_state ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE loyalty_state ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE loyalty_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage loyalty_state" ON loyalty_state;
CREATE POLICY "service role can manage loyalty_state" ON loyalty_state
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ============================================================
-- 22. Reward contracts (Style Challenges, wallet-credit grants)
-- Additive only. Wallet value remains authoritative in wallet_transactions.
-- ============================================================
CREATE TABLE IF NOT EXISTS reward_events (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
  event_id TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  ruleset_version TEXT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  qualifying_metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  verification_source TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE reward_events ADD COLUMN IF NOT EXISTS id UUID DEFAULT GEN_RANDOM_UUID();
ALTER TABLE reward_events ADD COLUMN IF NOT EXISTS event_id TEXT;
ALTER TABLE reward_events ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE reward_events ADD COLUMN IF NOT EXISTS event_type TEXT;
ALTER TABLE reward_events ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE reward_events ADD COLUMN IF NOT EXISTS ruleset_version TEXT;
ALTER TABLE reward_events ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE reward_events ADD COLUMN IF NOT EXISTS qualifying_metadata JSONB NOT NULL DEFAULT '{}'::JSONB;
ALTER TABLE reward_events ADD COLUMN IF NOT EXISTS verification_source TEXT;
ALTER TABLE reward_events ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE reward_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE reward_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage reward_events" ON reward_events;
CREATE POLICY "service role can manage reward_events" ON reward_events FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
CREATE INDEX IF NOT EXISTS reward_events_user_idx ON reward_events (user_id, occurred_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS reward_events_event_id_uidx ON reward_events (event_id);
CREATE UNIQUE INDEX IF NOT EXISTS reward_events_idempotency_key_uidx ON reward_events (idempotency_key);

CREATE TABLE IF NOT EXISTS reward_grants (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
  grant_id TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL,
  source_event_id TEXT,
  source TEXT NOT NULL,
  reward_type TEXT NOT NULL CHECK (reward_type IN ('nood_coins','xp','wallet_credit','coupon','shipping_benefit','product_reward','unlock')),
  amount NUMERIC NOT NULL DEFAULT 0,
  currency TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','locked','available','redeemed','expired','revoked')),
  unlock_condition JSONB,
  expires_at TIMESTAMPTZ,
  redeemed_at TIMESTAMPTZ,
  ruleset_version TEXT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE reward_grants ADD COLUMN IF NOT EXISTS id UUID DEFAULT GEN_RANDOM_UUID();
ALTER TABLE reward_grants ADD COLUMN IF NOT EXISTS grant_id TEXT;
ALTER TABLE reward_grants ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE reward_grants ADD COLUMN IF NOT EXISTS source_event_id TEXT;
ALTER TABLE reward_grants ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE reward_grants ADD COLUMN IF NOT EXISTS reward_type TEXT;
ALTER TABLE reward_grants ADD COLUMN IF NOT EXISTS amount NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE reward_grants ADD COLUMN IF NOT EXISTS currency TEXT;
ALTER TABLE reward_grants ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE reward_grants ADD COLUMN IF NOT EXISTS unlock_condition JSONB;
ALTER TABLE reward_grants ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE reward_grants ADD COLUMN IF NOT EXISTS redeemed_at TIMESTAMPTZ;
ALTER TABLE reward_grants ADD COLUMN IF NOT EXISTS ruleset_version TEXT;
ALTER TABLE reward_grants ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE reward_grants ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::JSONB;
ALTER TABLE reward_grants ADD COLUMN IF NOT EXISTS issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE reward_grants ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE reward_grants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage reward_grants" ON reward_grants;
CREATE POLICY "service role can manage reward_grants" ON reward_grants FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
CREATE INDEX IF NOT EXISTS reward_grants_user_idx ON reward_grants (user_id, issued_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS reward_grants_grant_id_uidx ON reward_grants (grant_id);
CREATE UNIQUE INDEX IF NOT EXISTS reward_grants_idempotency_key_uidx ON reward_grants (idempotency_key);

CREATE TABLE IF NOT EXISTS style_dna_completions (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
  user_id TEXT NOT NULL,
  event_version TEXT NOT NULL,
  profile_version INTEGER NOT NULL CHECK (profile_version > 0),
  selection_summary JSONB NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, event_version)
);
ALTER TABLE style_dna_completions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage style_dna_completions" ON style_dna_completions;
CREATE POLICY "service role can manage style_dna_completions" ON style_dna_completions
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- Constraints are added NOT VALID so legacy rows can be audited by the preflight
-- without blocking this additive definition step. PostgreSQL still enforces them
-- for every new or changed row. Production deployment validates them only after
-- the preflight confirms there are no orphaned or invalid legacy records.
DO $$ BEGIN
  ALTER TABLE reward_grants ADD CONSTRAINT reward_grants_type_check
    CHECK (reward_type IN ('nood_coins','xp','wallet_credit','coupon','shipping_benefit','product_reward','unlock')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE reward_grants ADD CONSTRAINT reward_grants_status_check
    CHECK (status IN ('pending','locked','available','redeemed','expired','revoked')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE reward_grants ADD CONSTRAINT reward_grants_source_event_fk
    FOREIGN KEY (source_event_id) REFERENCES reward_events(event_id) ON DELETE RESTRICT NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
ALTER TABLE reward_grants VALIDATE CONSTRAINT reward_grants_type_check;
ALTER TABLE reward_grants VALIDATE CONSTRAINT reward_grants_status_check;
ALTER TABLE reward_grants VALIDATE CONSTRAINT reward_grants_source_event_fk;

-- ============================================================
-- 22. Coupon campaigns and atomic checkout reservations
-- ============================================================
CREATE TABLE IF NOT EXISTS coupon_campaigns (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
  code TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  discount_type TEXT NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
  discount_value NUMERIC NOT NULL CHECK (discount_value > 0),
  max_discount NUMERIC,
  min_subtotal NUMERIC NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  max_redemptions INTEGER,
  per_user_limit INTEGER NOT NULL DEFAULT 1 CHECK (per_user_limit > 0),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at TIMESTAMPTZ NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🏷️',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at > starts_at),
  CHECK (max_discount IS NULL OR max_discount >= 0),
  CHECK (max_redemptions IS NULL OR max_redemptions > 0)
);

ALTER TABLE coupon_campaigns ADD COLUMN IF NOT EXISTS id UUID;
ALTER TABLE coupon_campaigns ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE coupon_campaigns ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE coupon_campaigns ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE coupon_campaigns ADD COLUMN IF NOT EXISTS discount_type TEXT;
ALTER TABLE coupon_campaigns ADD COLUMN IF NOT EXISTS discount_value NUMERIC;
ALTER TABLE coupon_campaigns ADD COLUMN IF NOT EXISTS max_discount NUMERIC;
ALTER TABLE coupon_campaigns ADD COLUMN IF NOT EXISTS min_subtotal NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE coupon_campaigns ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE coupon_campaigns ADD COLUMN IF NOT EXISTS max_redemptions INTEGER;
ALTER TABLE coupon_campaigns ADD COLUMN IF NOT EXISTS per_user_limit INTEGER NOT NULL DEFAULT 1;
ALTER TABLE coupon_campaigns ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE coupon_campaigns ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ;
ALTER TABLE coupon_campaigns ADD COLUMN IF NOT EXISTS emoji TEXT NOT NULL DEFAULT '🏷️';
ALTER TABLE coupon_campaigns ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE coupon_campaigns ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE coupon_campaigns ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE coupon_campaigns ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS coupon_campaigns_code_upper_idx ON coupon_campaigns (UPPER(code));
CREATE INDEX IF NOT EXISTS coupon_campaigns_active_window_idx ON coupon_campaigns (active, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS coupon_reservations (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
  campaign_id UUID NOT NULL REFERENCES coupon_campaigns (id),
  user_id TEXT NOT NULL,
  checkout_reference TEXT UNIQUE NOT NULL,
  order_id TEXT,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'consumed', 'released')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE coupon_reservations ADD COLUMN IF NOT EXISTS id UUID;
ALTER TABLE coupon_reservations ADD COLUMN IF NOT EXISTS campaign_id UUID;
ALTER TABLE coupon_reservations ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE coupon_reservations ADD COLUMN IF NOT EXISTS checkout_reference TEXT;
ALTER TABLE coupon_reservations ADD COLUMN IF NOT EXISTS order_id TEXT;
ALTER TABLE coupon_reservations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'reserved';
ALTER TABLE coupon_reservations ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE coupon_reservations ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE coupon_reservations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS coupon_reservations_campaign_idx ON coupon_reservations (campaign_id, status);
CREATE INDEX IF NOT EXISTS coupon_reservations_user_idx ON coupon_reservations (user_id, campaign_id, status);

ALTER TABLE coupon_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupon_reservations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage coupon_campaigns" ON coupon_campaigns;
CREATE POLICY "service role can manage coupon_campaigns" ON coupon_campaigns
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
DROP POLICY IF EXISTS "service role can manage coupon_reservations" ON coupon_reservations;
CREATE POLICY "service role can manage coupon_reservations" ON coupon_reservations
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

CREATE OR REPLACE FUNCTION reserve_coupon_atomic(
  p_campaign_id UUID,
  p_user_id TEXT,
  p_checkout_reference TEXT,
  p_ttl_minutes INTEGER DEFAULT 30
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  campaign coupon_campaigns%ROWTYPE;
  existing coupon_reservations%ROWTYPE;
  total_used INTEGER;
  user_used INTEGER;
  reservation_id UUID;
BEGIN
  IF COALESCE(TRIM(p_user_id), '') = '' OR COALESCE(TRIM(p_checkout_reference), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_reservation_identity');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(p_campaign_id::TEXT));
  SELECT * INTO existing FROM coupon_reservations WHERE checkout_reference = p_checkout_reference;
  IF FOUND THEN
    IF existing.campaign_id = p_campaign_id AND existing.user_id = p_user_id
       AND existing.status IN ('reserved', 'consumed') THEN
      RETURN jsonb_build_object('ok', true, 'replay', true, 'reservationId', existing.id);
    END IF;
    RETURN jsonb_build_object('ok', false, 'error', 'checkout_reference_conflict');
  END IF;
  UPDATE coupon_reservations SET status = 'released', updated_at = NOW()
    WHERE status = 'reserved' AND expires_at <= NOW();
  SELECT * INTO campaign FROM coupon_campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND OR NOT campaign.active OR campaign.starts_at > NOW() OR campaign.ends_at <= NOW() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'coupon_inactive');
  END IF;
  SELECT COUNT(*) INTO total_used FROM coupon_reservations
    WHERE campaign_id = p_campaign_id AND status IN ('reserved', 'consumed');
  IF campaign.max_redemptions IS NOT NULL AND total_used >= campaign.max_redemptions THEN
    RETURN jsonb_build_object('ok', false, 'error', 'coupon_limit_reached');
  END IF;
  SELECT COUNT(*) INTO user_used FROM coupon_reservations
    WHERE campaign_id = p_campaign_id AND user_id = p_user_id AND status IN ('reserved', 'consumed');
  IF user_used >= campaign.per_user_limit THEN
    RETURN jsonb_build_object('ok', false, 'error', 'coupon_already_used');
  END IF;
  INSERT INTO coupon_reservations (campaign_id, user_id, checkout_reference, expires_at)
    VALUES (p_campaign_id, p_user_id, p_checkout_reference,
      NOW() + make_interval(mins => GREATEST(1, LEAST(COALESCE(p_ttl_minutes, 30), 120))))
    RETURNING id INTO reservation_id;
  RETURN jsonb_build_object('ok', true, 'replay', false, 'reservationId', reservation_id);
END;
$$;

CREATE OR REPLACE FUNCTION consume_coupon_reservation(
  p_checkout_reference TEXT,
  p_order_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  changed coupon_reservations%ROWTYPE;
BEGIN
  UPDATE coupon_reservations SET status = 'consumed', order_id = p_order_id, updated_at = NOW()
    WHERE checkout_reference = p_checkout_reference AND status = 'reserved'
    RETURNING * INTO changed;
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'replay', false); END IF;
  SELECT * INTO changed FROM coupon_reservations WHERE checkout_reference = p_checkout_reference;
  IF FOUND AND changed.status = 'consumed' AND changed.order_id = p_order_id THEN
    RETURN jsonb_build_object('ok', true, 'replay', true);
  END IF;
  RETURN jsonb_build_object('ok', false, 'error', 'reservation_not_found');
END;
$$;

REVOKE ALL ON FUNCTION reserve_coupon_atomic(UUID, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION consume_coupon_reservation(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reserve_coupon_atomic(UUID, TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION consume_coupon_reservation(TEXT, TEXT) TO service_role;

-- ============================================================
-- 23. Support cases and immutable conversation history
-- ============================================================
CREATE TABLE IF NOT EXISTS support_cases (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(), ticket_id TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL, customer_email TEXT, category TEXT NOT NULL, subject TEXT NOT NULL,
  order_id TEXT, priority TEXT NOT NULL DEFAULT 'normal', status TEXT NOT NULL DEFAULT 'open',
  assigned_role TEXT, sla_due_at TIMESTAMPTZ, escalated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS support_messages (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(), case_id UUID NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  sender_user_id TEXT, sender_role TEXT NOT NULL CHECK (sender_role IN ('customer', 'agent', 'system')),
  body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS support_cases_user_idx ON support_cases(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS support_messages_case_idx ON support_messages(case_id, created_at);
ALTER TABLE support_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage support_cases" ON support_cases;
CREATE POLICY "service role can manage support_cases" ON support_cases FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
DROP POLICY IF EXISTS "service role can manage support_messages" ON support_messages;
CREATE POLICY "service role can manage support_messages" ON support_messages FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ============================================================
-- 24. Verified and moderated product reviews
-- ============================================================
CREATE TABLE IF NOT EXISTS product_reviews (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(), user_id TEXT NOT NULL, order_id TEXT NOT NULL,
  order_item_id TEXT NOT NULL, product_handle TEXT NOT NULL, rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title TEXT, body TEXT NOT NULL, photo_urls JSONB NOT NULL DEFAULT '[]', verified_purchase BOOLEAN NOT NULL DEFAULT FALSE,
  helpful_count INTEGER NOT NULL DEFAULT 0, report_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'rejected', 'hidden')),
  moderation_note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, order_item_id)
);
CREATE TABLE IF NOT EXISTS review_votes (
  review_id UUID NOT NULL REFERENCES product_reviews(id) ON DELETE CASCADE, user_id TEXT NOT NULL,
  helpful BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(review_id, user_id)
);
CREATE TABLE IF NOT EXISTS review_reports (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(), review_id UUID NOT NULL REFERENCES product_reviews(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL, reason TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(review_id, user_id)
);
CREATE INDEX IF NOT EXISTS product_reviews_product_idx ON product_reviews(product_handle, status, created_at DESC);
ALTER TABLE product_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage product_reviews" ON product_reviews;
CREATE POLICY "service role can manage product_reviews" ON product_reviews FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
DROP POLICY IF EXISTS "service role can manage review_votes" ON review_votes;
CREATE POLICY "service role can manage review_votes" ON review_votes FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
DROP POLICY IF EXISTS "service role can manage review_reports" ON review_reports;
CREATE POLICY "service role can manage review_reports" ON review_reports FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ============================================================
-- 25. Privacy-respecting product analytics and security events
-- ============================================================
CREATE TABLE IF NOT EXISTS product_analytics (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(), event TEXT NOT NULL, user_id TEXT,
  session_hash TEXT, properties JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS security_events (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(), user_id TEXT NOT NULL, event_type TEXT NOT NULL,
  device_fingerprint TEXT, risk_level TEXT NOT NULL DEFAULT 'low', metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_analytics_event_idx ON product_analytics(event, created_at DESC);
CREATE INDEX IF NOT EXISTS security_events_user_idx ON security_events(user_id, created_at DESC);
ALTER TABLE product_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service role can manage product_analytics" ON product_analytics;
CREATE POLICY "service role can manage product_analytics" ON product_analytics FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
DROP POLICY IF EXISTS "service role can manage security_events" ON security_events;
CREATE POLICY "service role can manage security_events" ON security_events FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ============================================================
-- End of migration
-- ============================================================

-- WiPay stores the trusted quote with the durable payment session.
ALTER TABLE payment_sessions ADD COLUMN IF NOT EXISTS quote JSONB;
ALTER TABLE payment_sessions ADD COLUMN IF NOT EXISTS coupon_reference TEXT;
