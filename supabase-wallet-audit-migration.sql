-- Repairs missing wallet storage without creating or changing financial records.
BEGIN;
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
DO $policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'reward_ledger' AND policyname = 'service role can manage reward_ledger') THEN
    CREATE POLICY "service role can manage reward_ledger" ON reward_ledger FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
  END IF;
END $policy$;

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
DO $policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'wallet_transactions' AND policyname = 'service role can manage wallet_transactions') THEN
    CREATE POLICY "service role can manage wallet_transactions" ON wallet_transactions FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
  END IF;
END $policy$;

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
  IF p_user_id IS NULL OR BTRIM(p_user_id) = '' OR p_amount IS NULL OR p_idempotency_key IS NULL OR p_currency <> 'USD' THEN
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

REVOKE ALL ON FUNCTION apply_wallet_transaction_atomic(TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
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

REVOKE ALL ON FUNCTION issue_reward_atomic(TEXT, TEXT, NUMERIC, TEXT, INTEGER, TEXT, TEXT, TIMESTAMPTZ, JSONB, NUMERIC, NUMERIC, NUMERIC, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION issue_reward_atomic(TEXT, TEXT, NUMERIC, TEXT, INTEGER, TEXT, TEXT, TIMESTAMPTZ, JSONB, NUMERIC, NUMERIC, NUMERIC, NUMERIC) TO service_role;


COMMIT;
