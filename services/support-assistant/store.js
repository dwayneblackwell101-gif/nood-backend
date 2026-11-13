function dbError(error, fallback) {
  const next = new Error(error?.message || fallback);
  next.code = 'assistant_storage_unavailable';
  return next;
}

function createConversationStore(supabase) {
  if (!supabase) {
    const memory = new Map();
    return {
      async create(userId) { const row = { id: `dev-${Date.now()}`, user_id: userId, status: 'active', messages: [] }; memory.set(row.id, row); return row; },
      async getOwned(id, userId) { const row = memory.get(id); return row?.user_id === userId ? row : null; },
      async getLatest(userId) { return [...memory.values()].reverse().find((row) => row.user_id === userId && row.status === 'active') || null; },
      async listMessages(id) { return memory.get(id)?.messages || []; },
      async addMessage({ conversationId, senderRole, body, intent, metadata }) { const row = memory.get(conversationId); if (!row) throw dbError(null, 'Conversation could not be loaded.'); const msg = { id: `dev-msg-${Date.now()}-${Math.random()}`, sender_role: senderRole, body: String(body || '').slice(0, 4000), intent: intent || null, metadata: metadata || {}, created_at: new Date().toISOString() }; row.messages.push(msg); return msg; },
      async linkCase() { throw dbError(null, 'Development test handoff is disabled.'); },
    };
  }

  async function create(userId) {
    const { data, error } = await supabase.from('assistant_conversations')
      .insert({ user_id: userId, status: 'active' }).select().single();
    if (error || !data) throw dbError(error, 'Conversation could not be created.');
    return data;
  }

  async function getOwned(conversationId, userId) {
    const { data, error } = await supabase.from('assistant_conversations')
      .select('*').eq('id', conversationId).eq('user_id', userId).maybeSingle();
    if (error) throw dbError(error, 'Conversation could not be loaded.');
    return data || null;
  }

  async function getLatest(userId) {
    const { data, error } = await supabase.from('assistant_conversations')
      .select('*').eq('user_id', userId).eq('status', 'active')
      .order('updated_at', { ascending: false }).limit(1).maybeSingle();
    if (error) throw dbError(error, 'Conversation could not be loaded.');
    return data || null;
  }

  async function listMessages(conversationId) {
    const { data, error } = await supabase.from('assistant_messages')
      .select('id, sender_role, body, intent, metadata, created_at')
      .eq('conversation_id', conversationId).order('created_at', { ascending: false }).limit(200);
    if (error) throw dbError(error, 'Conversation messages could not be loaded.');
    return (data || []).reverse();
  }

  async function addMessage({ conversationId, senderRole, body, intent, metadata }) {
    const safeMetadata = metadata && typeof metadata === 'object' ? metadata : {};
    const { data, error } = await supabase.from('assistant_messages').insert({
      conversation_id: conversationId,
      sender_role: senderRole,
      body: String(body || '').slice(0, 4000),
      intent: intent || null,
      metadata: safeMetadata,
    }).select().single();
    if (error || !data) throw dbError(error, 'Conversation message could not be saved.');
    await supabase.from('assistant_conversations').update({
      last_intent: intent || null,
      updated_at: new Date().toISOString(),
    }).eq('id', conversationId);
    return data;
  }

  async function linkCase(conversationId, userId, caseId) {
    const { data, error } = await supabase.from('assistant_conversations').update({
      linked_case_id: caseId,
      status: 'handed_off',
      updated_at: new Date().toISOString(),
    }).eq('id', conversationId).eq('user_id', userId).select().maybeSingle();
    if (error || !data) throw dbError(error, 'Conversation handoff could not be saved.');
    return data;
  }

  return { create, getOwned, getLatest, listMessages, addMessage, linkCase };
}

module.exports = { createConversationStore };
