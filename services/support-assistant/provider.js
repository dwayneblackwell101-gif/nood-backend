const { deterministicProvider } = require('./providers/deterministic');

function createSupportAssistantProvider({ name, tools, syntheticOnly = false }) {
  const providerName = String(name || process.env.SUPPORT_ASSISTANT_PROVIDER || 'deterministic').trim().toLowerCase();
  if (providerName === 'deterministic') return deterministicProvider({ tools });
  if (providerName === 'ai' || providerName === 'openai') {
    return require('./providers/openai').openaiProvider({ tools });
  }
  if (providerName === 'groq') {
    return require('./providers/groq').groqProvider({ syntheticOnly });
  }
  const error = new Error(`Unsupported support assistant provider: ${providerName}`);
  error.code = 'provider_unavailable';
  throw error;
}

module.exports = { createSupportAssistantProvider };

