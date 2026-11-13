const { createConversationStore } = require('./store');
const { createCustomerSupportTools } = require('./tools');
const { createSupportAssistantProvider } = require('./provider');

const GREETING = "Hi! I'm NOOD AI. How can I help you today?";

function publicMessage(row) {
  return {
    id: row.id,
    sender: row.sender_role,
    text: row.body,
    intent: row.intent || null,
    metadata: row.metadata || {},
    createdAt: row.created_at,
  };
}

function safeResponse({ conversation, response, customerMessage, assistantMessage }) {
  return {
    conversationId: conversation.id,
    message: response.message,
    state: response.state,
    suggestedActions: response.suggestedActions || [],
    handoff: response.handoff || null,
    data: response.data || {},
    messages: [publicMessage(customerMessage), publicMessage(assistantMessage)],
  };
}

function createSupportAssistantService({ supabase, providerName, wallet } = {}) {
  const store = createConversationStore(supabase);

  async function getConversation({ customer, conversationId, latest = false }) {
    let conversation = latest ? await store.getLatest(customer.userId) : await store.getOwned(conversationId, customer.userId);
    if (!conversation && latest) return { conversationId: null, messages: [], greeting: GREETING };
    if (!conversation) {
      const error = new Error('Assistant conversation not found.');
      error.code = 'conversation_not_found';
      throw error;
    }
    return {
      conversationId: conversation.id,
      status: conversation.status,
      messages: (await store.listMessages(conversation.id)).map(publicMessage),
      greeting: GREETING,
    };
  }

  async function sendMessage({ customer, message, conversationId, context }) {
    let conversation = conversationId ? await store.getOwned(conversationId, customer.userId) : null;
    if (conversationId && !conversation) {
      const error = new Error('Assistant conversation not found.');
      error.code = 'conversation_not_found';
      throw error;
    }
    if (!conversation || conversation.status !== 'active') conversation = await store.create(customer.userId);

    const tools = createCustomerSupportTools({ supabase, customer, wallet });
    const provider = createSupportAssistantProvider({ name: providerName, tools });
    const customerMessage = await store.addMessage({
      conversationId: conversation.id,
      senderRole: 'customer',
      body: message,
      intent: null,
      metadata: context?.selectedOrderId ? { selectedOrderId: context.selectedOrderId } : {},
    });

    let response = await provider.respond({ message, context, conversationId: conversation.id, store });
    if (customer.developmentTestSession === true) response = { ...response, data: {}, handoff: null, suggestedActions: [], message: `${response.message}\n\nDevelopment test session: no customer data is connected.` };
    const assistantMessage = await store.addMessage({
      conversationId: conversation.id,
      senderRole: 'assistant',
      body: response.message,
      intent: response.intent,
      metadata: {
        state: response.state,
        suggestedActions: response.suggestedActions || [],
        handoff: response.handoff || null,
      },
    });
    return safeResponse({ conversation, response, customerMessage, assistantMessage });
  }

  return { getConversation, sendMessage, greeting: GREETING };
}

module.exports = { createSupportAssistantService, GREETING, publicMessage };
