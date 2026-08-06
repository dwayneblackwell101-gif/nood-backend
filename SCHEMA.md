# NOOD Supabase Schema

Run these in the Supabase SQL Editor to create the tables the backend needs.

## Video feed engagement (likes, comments, shares)

```sql
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

create index if not exists video_comments_video_id_idx on video_comments (video_id, created_at desc);

-- Atomic counter increment function (used by the backend)
create or replace function increment_engagement(video_id text, col text, delta int)
returns void language plpgsql as $$
begin
  execute format(
    'update video_engagement set %I = greatest(0, %I + $1), updated_at = now() where video_id = $2',
    col, col
  ) using delta, video_id;
end $$;
```

## (Optional) Order tracking sync

```sql
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

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  shopify_product_id text unique,
  title text,
  handle text,
  available_for_sale boolean default true,
  total_inventory integer default 0,
  variants jsonb default '[]',
  updated_at timestamptz not null default now()
);

create table if not exists carts (
  id uuid primary key default gen_random_uuid(),
  email text,
  name text,
  items jsonb default '[]',
  recovery_email_sent_at timestamptz,
  recovery_discount_code text,
  updated_at timestamptz not null default now()
);
```

## Enable RLS (recommended for production)

For the video feed tables, the backend uses the **service role key** which
bypasses RLS. If you want public reads + authenticated writes from the app
directly (without going through the backend), add policies:

```sql
alter table video_engagement enable row level security;
alter table video_comments enable row level security;
alter table video_likes enable row level security;

create policy "public read engagement" on video_engagement for select using (true);
create policy "public read comments" on video_comments for select using (true);
create policy "public insert comments" on video_comments for insert with check (true);
```
