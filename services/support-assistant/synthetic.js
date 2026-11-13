// Fictional fixtures only. This module must never import a customer, DB or Shopify service.
const scenarios = Object.freeze({
  tracking: {
    label: 'Track a fictional order',
    turns: ['Where is my fictional order DEMO-1001?', 'What was its latest delivery update?'],
    previousAnswer: 'Fictional order DEMO-1001 is in transit with Demo Carrier.',
  },
  product: {
    label: 'Ask about a fictional product',
    turns: ['What sizes and price does the fictional Demo Orange Tee have?', 'Is the medium size available?'],
    previousAnswer: 'The fictional Demo Orange Tee is USD 20 and has Small, Medium and Large options.',
  },
  refund: {
    label: 'Check a fictional refund status',
    turns: ['What is the refund status for fictional order DEMO-1001?', 'Can you issue that refund or charge my card?'],
    previousAnswer: 'Fictional refund DEMO-REFUND-1 is pending review; no refund has been issued.',
  },
  policy: {
    label: 'Ask about a fictional return policy',
    turns: ['What is the fictional demo return policy?', 'Can I speak to a human instead?'],
    previousAnswer: 'The fictional demonstration policy allows a return request within 14 days; this is not NOOD policy.',
  },
});

function getScenario(id, turn = 0) {
  if (!Object.hasOwn(scenarios, id) || !Number.isInteger(turn) || turn < 0 || turn > 1) return null;
  const scenario = scenarios[id];
  const messages = turn === 1 ? [
    { role: 'user', content: scenario.turns[0] },
    { role: 'assistant', content: scenario.previousAnswer },
  ] : [];
  messages.push({ role: 'user', content: scenario.turns[turn] });
  return { prompt: scenario.turns[turn], messages };
}

function listScenarios() {
  return Object.entries(scenarios).map(([id, s]) => ({ id, label: s.label, turns: [...s.turns] }));
}

function createSyntheticTools() {
  const order = { shopify_order_id: 'DEMO-1001', name: 'DEMO-1001', status: 'paid', fulfillment_status: 'in_transit', fictional: true };
  return {
    list_orders: async () => [{ ...order }],
    get_order: async ({ orderId }) => orderId === order.shopify_order_id ? { ...order } : { error: 'order_not_available' },
    get_tracking: async ({ orderId }) => orderId === order.shopify_order_id
      ? { fictional: true, status: 'in_transit', carrier: 'Demo Carrier', latest_event_description: 'Fictional parcel left the demonstration sorting hub.', estimated_delivery: null }
      : { error: 'order_not_available' },
    refund_status: async () => [{ fictional: true, request_id: 'DEMO-REFUND-1', order_number: 'DEMO-1001', status: 'pending_review', amount: 20, currency: 'USD' }],
    search_products: async () => [{ fictional: true, title: 'Demo Orange Tee', price: 20, currency: 'USD',
      variants: [{ title: 'Small', available: true }, { title: 'Medium', available: true }, { title: 'Large', available: false }] }],
    support_policies: async () => ({ fictional: true, text: 'Fictional demo only: return requests within 14 days. This is NOT an actual NOOD policy.' }),
  };
}
module.exports = { getScenario, listScenarios, createSyntheticTools };
