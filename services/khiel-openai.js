const { openaiProvider, INSTRUCTIONS } = require('./support-assistant/providers/openai');
const { authenticateCustomer } = require('./customer-auth');
const { createCustomerSupportTools } = require('./support-assistant/tools');
const { supabaseAdmin } = require('../utils/supabase-admin');

// Future activation was approved by the user. Keep paid requests OFF until a
// dedicated key is deliberately supplied; ignore the unrelated old OpenAI key.
function khielKey(env = process.env) { return String(env.KHIEL_OPENAI_API_KEY || '').trim(); }

async function khielOpenAIReply({ req, messages, apiKey, request, authenticate = authenticateCustomer,
  db = supabaseAdmin, providerFactory = openaiProvider }) {
  const customer = req.headers?.authorization ? await authenticate(req) : null;
  const call = async (method, ...args) => {
    if (!customer?.userId) return { error: 'sign_in_required', route: '/account/auth' };
    if (!db) return { error: 'account_service_unavailable' };
    return createCustomerSupportTools({ supabase: db, customer })[method](...args);
  };
  const provider = providerFactory({ apiKey, request,
    model: process.env.NOOD_AI_TEXT_MODEL || 'gpt-4.1-mini',
    instructions: INSTRUCTIONS.replace('You are NOOD AI,', 'You are Khiel,') + '\nYour name is Khiel. Keep replies brief and suitable for speaking.',
    tools: {
      listRecentOrders: (limit) => call('listRecentOrders', limit),
      getOwnedOrder: (id) => call('getOwnedOrder', id),
      getOwnedTracking: (id) => call('getOwnedTracking', id),
      listRefundRequests: (limit) => call('listRefundRequests', limit),
    },
  });
  const result = await provider.respond({ message: messages.at(-1).content, conversationId: 'current-screen',
    store: { listMessages: async () => messages.map((message) => ({ sender_role: message.role === 'user' ? 'customer' : 'assistant', body: message.content })) },
  });
  return result.message;
}
module.exports = { khielKey, khielOpenAIReply };
