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
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='wishlist_items' AND policyname='service role can manage wishlist_items') THEN
    CREATE POLICY "service role can manage wishlist_items" ON wishlist_items FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS wishlist_items_user_id_idx ON wishlist_items (user_id);
CREATE INDEX IF NOT EXISTS wishlist_items_email_idx ON wishlist_items (email);
CREATE INDEX IF NOT EXISTS wishlist_items_handle_idx ON wishlist_items (handle);

