const ACTIONS = {
  tracking: { id: 'tracking', label: 'Open tracking', type: 'route', value: '/account/tracking' },
  returns: { id: 'returns', label: 'Return an item', type: 'route', value: '/account/returns' },
  refunds: { id: 'refunds', label: 'Refund status', type: 'message', value: 'Where is my refund?' },
  wallet: { id: 'wallet', label: 'Open wallet', type: 'route', value: '/account/wallet' },
  payment: { id: 'payment', label: 'Payment methods', type: 'route', value: '/account/payment-methods' },
  security: { id: 'security', label: 'Security settings', type: 'route', value: '/account/security' },
  handoff: { id: 'handoff', label: 'Talk to a person', type: 'handoff', value: 'Talk to a person' },
};

function recognizeIntent(message) {
  const text = String(message || '').toLowerCase();
  if (/talk to (a )?(person|human)|need (an )?agent|customer service|didn['’]?t help|human support/.test(text)) return 'handoff';
  if (/delivered.*(not|never|missing)|don['’]?t have|didn['’]?t (get|receive)|package.*missing/.test(text)) return 'delivery_problem';
  if (/refund|return|send (it|this) back/.test(text)) return /return|send (it|this) back/.test(text) && !/refund/.test(text) ? 'return' : 'refund';
  if (/track|where.*(order|package)|shipp?ed|shipment|package|order.*late|delivery/.test(text)) return 'tracking';
  if (/wallet|balance|reward|credit|points/.test(text)) return 'wallet';
  if (/payment|charged|charge|card|checkout|declined|paid twice|duplicate/.test(text)) return 'payment';
  if (/login|log in|sign in|password|security|account/.test(text)) return 'account';
  if (/order|purchase/.test(text)) return 'order';
  return 'unknown';
}

function orderLabel(order) {
  return order?.name || order?.shopify_order_id || 'your order';
}

function deterministicProvider({ tools }) {
  async function respond({ message, context = {}, conversationId, store }) {
    const intent = recognizeIntent(message);

    if (intent === 'handoff') {
      if (context.confirmHandoff === true) {
        const result = await tools.createHumanHandoff({
          category: context.category || 'other',
          subject: context.subject || 'Help requested through Khiel',
          message,
          orderId: context.selectedOrderId,
          conversationId,
          store,
        });
        return {
          intent,
          message: `${result.reused ? 'I added this to' : 'I created'} support case ${result.supportCase.ticket_id}. A NOOD support person can continue with you there.`,
          state: 'handoff',
          suggestedActions: [{ id: 'open-case', label: 'Open support case', type: 'route', value: `/account/support/${result.supportCase.ticket_id}` }],
          handoff: { ticketId: result.supportCase.ticket_id, reused: result.reused, route: `/account/support/${result.supportCase.ticket_id}` },
          data: {},
        };
      }
      return {
        intent,
        message: 'I can connect you with NOOD Support and include a short summary of this conversation. Would you like me to create or continue a support case?',
        state: 'talking',
        suggestedActions: [{ ...ACTIONS.handoff, label: 'Yes, talk to a person' }],
        handoff: { requiresConfirmation: true },
        data: {},
      };
    }

    if (intent === 'tracking' || intent === 'delivery_problem' || intent === 'order') {
      const orders = context.selectedOrderId
        ? [await tools.getOwnedOrder(context.selectedOrderId)].filter(Boolean)
        : await tools.listRecentOrders(5);
      if (!orders.length) {
        return {
          intent,
          message: 'I could not find a recent order for this signed-in account. I will not guess at an order status. You can refresh Orders or ask a support person to investigate.',
          state: 'talking',
          suggestedActions: [{ id: 'orders', label: 'Open orders', type: 'route', value: '/account/orders' }, ACTIONS.handoff],
          handoff: null,
          data: { orders: [] },
        };
      }
      const order = orders[0];
      const tracking = await tools.getOwnedTracking(order.shopify_order_id);
      const verifiedStatus = tracking?.friendly_status || tracking?.status || order.fulfillment_status || order.status || 'status unavailable';
      const detail = tracking?.latest_event_description || tracking?.latest_event_title || '';
      const prefix = intent === 'delivery_problem'
        ? 'I’m sorry your delivery is missing. '
        : '';
      return {
        intent,
        message: `${prefix}${orderLabel(order)} currently shows “${verifiedStatus}.”${detail ? ` Latest update: ${detail}` : ''}${intent === 'delivery_problem' ? ' If the carrier marked it delivered, please check the delivery location and then contact a person so we can investigate.' : ''}`,
        state: 'talking',
        suggestedActions: [ACTIONS.tracking, ...(intent === 'delivery_problem' ? [ACTIONS.handoff] : [])],
        handoff: null,
        data: {
          order: { id: order.shopify_order_id, name: order.name, status: order.status, fulfillmentStatus: order.fulfillment_status },
          tracking: tracking ? {
            status: tracking.status,
            friendlyStatus: tracking.friendly_status,
            carrier: tracking.carrier,
            trackingNumber: tracking.tracking_number,
            latestEvent: detail || null,
            estimatedDelivery: tracking.estimated_delivery,
          } : null,
        },
      };
    }

    if (intent === 'return' || intent === 'refund') {
      const refunds = await tools.listRefundRequests(10);
      if (!refunds.length) {
        return {
          intent,
          message: intent === 'return'
            ? 'I do not see an existing return request on this account. Open Returns to check eligibility and start one for an owned order.'
            : 'I do not see an existing refund request on this account. I will not estimate a refund that has not been recorded.',
          state: 'talking',
          suggestedActions: [ACTIONS.returns, ACTIONS.handoff],
          handoff: null,
          data: { refunds: [] },
        };
      }
      const latest = refunds[0];
      return {
        intent,
        message: `Your latest request for ${latest.order_number || latest.order_id} is “${String(latest.status || 'status unavailable').replace(/_/g, ' ')}.”${latest.refund_destination_label ? ` Destination: ${latest.refund_destination_label}.` : ''}`,
        state: 'talking',
        suggestedActions: [ACTIONS.returns, ACTIONS.handoff],
        handoff: null,
        data: { refund: { id: latest.request_id, orderNumber: latest.order_number, status: latest.status, updatedAt: latest.updated_at } },
      };
    }

    if (intent === 'wallet') {
      const wallet = await tools.getWalletSummary();
      return {
        intent,
        message: `Your verified NOOD Wallet balance is ${wallet.currency} ${wallet.balance.toFixed(2)}.${wallet.recentTransactions.length ? ' You can review recent activity in Wallet.' : ' There is no recent wallet activity to display.'}`,
        state: 'talking',
        suggestedActions: [ACTIONS.wallet, ACTIONS.handoff],
        handoff: null,
        data: { wallet },
      };
    }

    if (intent === 'payment') {
      return {
        intent,
        message: 'I can help with payment troubleshooting, but I cannot confirm a charge or promise a refund without a verified transaction. Do not send card numbers. Review your payment methods, or contact a person for a duplicate or completed charge.',
        state: 'talking',
        suggestedActions: [ACTIONS.payment, ACTIONS.handoff],
        handoff: null,
        data: {},
      };
    }

    if (intent === 'account') {
      return {
        intent,
        message: 'For sign-in problems, try signing in again through the Account screen. For security concerns, review Security settings and contact a person if you see activity you do not recognize. Never share your password or verification codes.',
        state: 'talking',
        suggestedActions: [ACTIONS.security, ACTIONS.handoff],
        handoff: null,
        data: {},
      };
    }

    return {
      intent,
      message: 'I can help with orders, tracking, deliveries, returns, refunds, payments, Wallet rewards, and account issues. Choose an option below, or talk to a person.',
      state: 'talking',
      suggestedActions: [ACTIONS.tracking, ACTIONS.refunds, ACTIONS.wallet, ACTIONS.handoff],
      handoff: null,
      data: {},
    };
  }

  return { name: 'deterministic', respond };
}

module.exports = { deterministicProvider, recognizeIntent, ACTIONS };
