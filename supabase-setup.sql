-- ============================================================
-- NOOD — Supabase setup (run this once in the SQL Editor)
-- ============================================================
-- This creates every table + function the backend needs.
-- Open https://supabase.com/dashboard → your project → SQL Editor
-- → New query → paste everything below → Run.

-- ─────────────────────────────────────────────
-- 1. Video feed engagement (likes, comments, shares)
-- ─────────────────────────────────────────────

-- Push notification tokens (persistent — survives Render restarts)
create table if not exists push_tokens (
  token text primary key,
  platform text default 'android',
  device_id text,
  user_id text,
  email text,
  app_version text,
  is_test boolean not null default false,
  is_active boolean not null default true,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS stays ENABLED. The backend uses the service-role key which bypasses
-- RLS. These policies only allow the service role / no-one publicly.
alter table push_tokens enable row level security;

-- Service role bypasses RLS automatically; these policies are a safety net.
-- No public/anonymous policies — the mobile app must never write here.
create policy "service role can manage push_tokens" on push_tokens
  for all to service_role using (true) with check (true);

-- Push campaign events — idempotency / duplicate protection + delivery stats.
-- campaign_id is the primary dedupe key; dedupe_key allows a second, semantic
-- dedupe (e.g. "don't promote this product handle twice in a window").
create table if not exists push_campaign_events (
  id uuid primary key default gen_random_uuid(),
  campaign_id text unique not null,
  campaign_type text not null default 'general',
  dedupe_key text unique,
  title text,
  body text,
  payload jsonb default '{}',
  status text not null default 'created',
  recipient_count integer not null default 0,
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  skipped_count integer not null default 0,
  created_at timestamptz not null default now()
);

alter table push_campaign_events enable row level security;
create policy "service role can manage push_campaign_events" on push_campaign_events
  for all to service_role using (true) with check (true);

create index if not exists push_campaign_events_dedupe_key_idx
  on push_campaign_events (dedupe_key);

-- Per-token daily promotional frequency counters.
create table if not exists push_frequency (
  token text not null,
  day text not null,
  promo_count integer not null default 0,
  last_promo_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (token, day)
);

alter table push_frequency enable row level security;
create policy "service role can manage push_frequency" on push_frequency
  for all to service_role using (true) with check (true);

-- Cart nudge cooldown (one row per cart scope).
create table if not exists push_cart_nudges (
  cart_key text primary key,
  last_nudge_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table push_cart_nudges enable row level security;
create policy "service role can manage push_cart_nudges" on push_cart_nudges
  for all to service_role using (true) with check (true);

-- Per-video engagement counters
create table if not exists video_engagement (
  video_id text primary key,
  likes integer not null default 0,
  shares integer not null default 0,
  updated_at timestamptz not null default now()
);

-- One row per like (unique per user per video)
create table if not exists video_likes (
  video_id text not null,
  user_id text not null,
  created_at timestamptz not null default now(),
  primary key (video_id, user_id)
);

-- All comments
create table if not exists video_comments (
  id uuid primary key default gen_random_uuid(),
  video_id text not null,
  user_id text not null default 'guest',
  author text not null default 'noodshop',
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists video_comments_video_id_idx
  on video_comments (video_id, created_at desc);

-- Atomic counter increment function (used by the backend to
-- safely +1 / -1 likes and shares under concurrency)
create or replace function increment_engagement(video_id text, col text, delta int)
returns void language plpgsql as $$
begin
  execute format(
    'update video_engagement set %I = greatest(0, %I + $1), updated_at = now() where video_id = $2',
    col, col
  ) using delta, video_id;
end $$;

-- ─────────────────────────────────────────────
-- 2. Order tracking sync (webhooks)
-- ─────────────────────────────────────────────

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  shopify_order_id text unique,
  email text,
  name text,
  total numeric,
  currency text default 'USD',
  status text,
  fulfillment_status text,
  tracking_number text,
  tracking_url text,
  tracking_company text,
  items jsonb default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- 3. Inventory sync (products)
-- ─────────────────────────────────────────────

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  shopify_product_id text unique,
  title text,
  handle text,
  available_for_sale boolean default true,
  total_inventory integer default 0,
  variants jsonb default '[]',
  created_at timestamptz not null default now(),
  notified_at timestamptz,
  updated_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- 4. Cart abandonment recovery
-- ─────────────────────────────────────────────

create table if not exists carts (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  profile_id text,
  name text,
  items jsonb default '[]',
  recovery_email_sent_at timestamptz,
  recovery_discount_code text,
  updated_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- 4b. Style Challenges (shared UGC contests)
-- ─────────────────────────────────────────────

create table if not exists style_challenges (
  id text primary key,
  theme text not null,
  subtitle text,
  emoji text,
  prize_usd numeric not null default 5,
  ends_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists challenge_submissions (
  id uuid primary key default gen_random_uuid(),
  challenge_id text not null references style_challenges (id),
  user_id text not null default 'guest',
  username text not null default 'nood_user',
  photo_uri text not null,
  caption text,
  created_at timestamptz not null default now()
);

create table if not exists challenge_votes (
  challenge_id text not null references style_challenges (id),
  submission_id uuid not null references challenge_submissions (id) on delete cascade,
  user_id text not null,
  created_at timestamptz not null default now(),
  primary key (submission_id, user_id)
);

-- Seed default challenges (safe to re-run)
insert into style_challenges (id, theme, subtitle, emoji, prize_usd, ends_at, active)
values
  ('summer-brunch', 'Summer Brunch', 'Show us your brunch fit', '🍹', 5, now() + interval '7 days', true),
  ('street-style', 'Street Style', 'Your best streetwear look', '🛹', 5, now() + interval '14 days', true),
  ('date-night', 'Date Night', 'Dress to impress', '🌹', 5, now() + interval '21 days', true)
on conflict (id) do nothing;

-- ─────────────────────────────────────────────
-- 5. Row Level Security (recommended)
-- ─────────────────────────────────────────────
-- The backend uses the service-role key which bypasses RLS.
-- These policies allow the app itself to read comments/engagement
-- directly from Supabase if you ever want that. Safe to keep on.

alter table video_engagement enable row level security;
alter table video_comments enable row level security;
alter table video_likes enable row level security;

create policy "public read engagement" on video_engagement
  for select using (true);

create policy "public read comments" on video_comments
  for select using (true);

create policy "public insert comments" on video_comments
  for insert with check (true);

create policy "public read likes" on video_likes
  for select using (true);

create policy "public insert likes" on video_likes
  for insert with check (true);

create policy "public delete own like" on video_likes
  for delete using (true);

-- ─────────────────────────────────────────────
-- Done. You should see "Success. No rows returned"
-- ─────────────────────────────────────────────
