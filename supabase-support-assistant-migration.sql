-- NOOD support-assistant conversations are intentionally separate from
-- human support_messages. Only the service-role backend may access them.

CREATE TABLE IF NOT EXISTS assistant_conversations (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'handed_off', 'closed')),
  linked_case_id UUID REFERENCES support_cases(id) ON DELETE SET NULL,
  last_intent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS assistant_messages (
  id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
  conversation_id UUID NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('customer', 'assistant', 'system')),
  body TEXT NOT NULL,
  intent TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS assistant_conversations_user_idx
  ON assistant_conversations(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS assistant_messages_conversation_idx
  ON assistant_messages(conversation_id, created_at);

ALTER TABLE assistant_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role can manage assistant_conversations" ON assistant_conversations;
CREATE POLICY "service role can manage assistant_conversations" ON assistant_conversations
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS "service role can manage assistant_messages" ON assistant_messages;
CREATE POLICY "service role can manage assistant_messages" ON assistant_messages
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

