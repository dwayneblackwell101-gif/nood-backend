const { adminGraphql } = require('../catalog/shopify');
const {
  getShopifyOrderAccessToken,
  hasShopifyOrderAdminAccessToken,
} = require('../shopify-order-access');

const METAFIELD_NAMESPACE = 'nood';
const METAFIELD_KEY = 'refund_request';
const BASE_TAG = 'refund-requested';

const PROVIDER_REFUND_API_CONFIRMED = false;

const REFUND_METHOD_TAGS = {
  original_payment: 'refund-method-original-payment',
  wallet: 'refund-method-nood-wallet',
};

const REFUND_STATUS_TAGS = {
  pending_review: 'refund-status-pending-review',
  approved: 'refund-status-approved',
  rejected: 'refund-status-rejected',
  refunded_to_wallet: 'refund-status-refunded-to-wallet',
  refunded_to_original: 'refund-status-refunded-to-original',
  manual_refund_required: 'refund-status-manual-refund-required',
  failed: 'refund-status-failed',
  cancelled: 'refund-status-cancelled',
};

const ALL_STATUS_TAGS = Object.values(REFUND_STATUS_TAGS);
const ALL_METHOD_TAGS = Object.values(REFUND_METHOD_TAGS);
const ALL_REFUND_TAGS = [BASE_TAG, ...ALL_STATUS_TAGS, ...ALL_METHOD_TAGS];

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function isWalletRefundMethod(refundMethod) {
  return safeString(refundMethod).toLowerCase() === 'wallet';
}

function getRefundDestinationMeta(record) {
  const wallet = isWalletRefundMethod(record.refund_method);

  return {
    refund_method: wallet ? 'nood_wallet' : 'original_payment',
    refund_destination_label: wallet ? 'NOOD Wallet' : 'Original payment method',
    requires_manual_provider_refund: !wallet && !PROVIDER_REFUND_API_CONFIRMED,
    wallet_refund_requested: wallet,
  };
}

function getStatusLabel(status) {
  const normalized = safeString(status, 'pending_review').toLowerCase();

  switch (normalized) {
    case 'pending_review':
      return 'Pending review';
    case 'approved':
      return 'Approved';
    case 'rejected':
      return 'Rejected';
    case 'refunded_to_wallet':
      return 'Refunded to NOOD Wallet';
    case 'refunded_to_original':
      return 'Refunded to original payment';
    case 'manual_refund_required':
      return 'Manual refund required';
    case 'failed':
      return 'Refund failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Pending review';
  }
}

function getActionNeeded(record) {
  const status = safeString(record.status, 'pending_review').toLowerCase();
  const wallet = isWalletRefundMethod(record.refund_method);

  if (status === 'pending_review') {
    return wallet
      ? 'Approve to credit customer NOOD Wallet.'
      : 'Review and refund through WiPay/PayPal/Shopify payment provider if approved.';
  }

  if (status === 'manual_refund_required') {
    return 'Process refund in WiPay/PayPal/Shopify, then mark_refunded.';
  }

  if (status === 'refunded_to_wallet') {
    return 'NOOD Wallet credited.';
  }

  if (status === 'refunded_to_original') {
    return 'Original payment refund completed.';
  }

  if (status === 'rejected') {
    return 'Refund request rejected.';
  }

  return '';
}

function buildRefundPayload(record) {
  const destination = getRefundDestinationMeta(record);
  const items = Array.isArray(record.items) ? record.items : [];

  return {
    refund_request_id: safeString(record.request_id),
    refund_status: safeString(record.status, 'pending_review'),
    status_label: getStatusLabel(record.status),
    refund_reason: safeString(record.reason),
    refund_method: destination.refund_method,
    refund_destination_label: destination.refund_destination_label,
    requires_manual_provider_refund: destination.requires_manual_provider_refund,
    wallet_refund_requested: destination.wallet_refund_requested,
    refund_amount: String(Number(record.amount || 0)),
    refund_currency: safeString(record.currency, 'TTD'),
    refund_items: items,
    request_date: safeString(record.created_at || record.updated_at),
    customer_email: safeString(record.customer_email),
    order_number: safeString(record.order_number),
    customer_note: safeString(record.notes),
    action_needed: getActionNeeded(record),
    updated_at: safeString(record.updated_at),
  };
}

function buildRefundNoteBlock(record) {
  const payload = buildRefundPayload(record);
  const itemsSummary = payload.refund_items
    .map((item) => `${safeString(item?.title, 'Item')} x${Number(item?.quantity || 1)}`)
    .join(', ');

  return [
    '[NOOD Refund Request]',
    `Refund Method: ${payload.refund_destination_label}`,
    `Status: ${payload.status_label}`,
    payload.action_needed ? `Action Needed: ${payload.action_needed}` : null,
    `Request ID: ${payload.refund_request_id}`,
    `Amount: ${payload.refund_amount} ${payload.refund_currency}`,
    `Items: ${itemsSummary || 'n/a'}`,
    `Reason: ${payload.refund_reason || 'n/a'}`,
    `Customer Note: ${payload.customer_note || 'n/a'}`,
    `Updated: ${payload.updated_at}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function normalizeShopifyOrderGid(rawValue) {
  const value = safeString(rawValue);
  if (!value) {
    return '';
  }

  if (value.startsWith('gid://shopify/Order/')) {
    return value;
  }

  const digits = value.replace(/\D/g, '');
  if (digits) {
    return `gid://shopify/Order/${digits}`;
  }

  return '';
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) {
    return tags.map((tag) => safeString(tag)).filter(Boolean);
  }

  return safeString(tags)
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function normalizeOrderNumber(rawValue) {
  const value = safeString(rawValue);
  if (!value) {
    return '';
  }

  return value.startsWith('#') ? value : `#${value}`;
}

function getOrderAccessToken() {
  return getShopifyOrderAccessToken();
}

function upsertNoteBlock(existingNote, nextBlock) {
  const note = safeString(existingNote);
  const marker = '[NOOD Refund Request]';
  const startIndex = note.indexOf(marker);

  if (startIndex === -1) {
    return note ? `${note}\n\n${nextBlock}` : nextBlock;
  }

  const before = note.slice(0, startIndex).trimEnd();
  const afterMarker = note.slice(startIndex);
  const nextSectionIndex = afterMarker.indexOf('\n\n[', marker.length);
  const trailing = nextSectionIndex >= 0 ? afterMarker.slice(nextSectionIndex).trimStart() : '';

  return [before, nextBlock, trailing].filter(Boolean).join('\n\n').trim();
}

function getTagsForRecord(record) {
  const methodTag = isWalletRefundMethod(record.refund_method)
    ? REFUND_METHOD_TAGS.wallet
    : REFUND_METHOD_TAGS.original_payment;
  const statusTag =
    REFUND_STATUS_TAGS[safeString(record.status, 'pending_review')] ||
    REFUND_STATUS_TAGS.pending_review;

  return [BASE_TAG, methodTag, statusTag];
}

async function resolveShopifyOrderGid({ shopifyOrderId, orderNumber }) {
  const directGid = normalizeShopifyOrderGid(shopifyOrderId);
  if (directGid) {
    return directGid;
  }

  const normalizedName = normalizeOrderNumber(orderNumber);
  if (!normalizedName) {
    return '';
  }

  const accessToken = getOrderAccessToken();
  if (!accessToken) {
    return '';
  }

  const query = `
    query refundOrderLookup($query: String!) {
      orders(first: 1, query: $query) {
        edges {
          node {
            id
            name
          }
        }
      }
    }
  `;

  const payload = await adminGraphql(
    query,
    { query: `name:${normalizedName}` },
    { accessToken, requestedQueryCost: 10 }
  );

  const node = payload?.data?.orders?.edges?.[0]?.node;
  return safeString(node?.id);
}

async function fetchShopifyOrderRefundState(orderGid) {
  const accessToken = getOrderAccessToken();
  if (!accessToken || !orderGid) {
    return null;
  }

  const query = `
    query refundOrderState($id: ID!) {
      order(id: $id) {
        id
        name
        note
        tags
        metafield(namespace: "${METAFIELD_NAMESPACE}", key: "${METAFIELD_KEY}") {
          value
        }
      }
    }
  `;

  const payload = await adminGraphql(query, { id: orderGid }, { accessToken, requestedQueryCost: 10 });
  return payload?.data?.order || null;
}

async function tagsAdd(orderGid, tags) {
  const accessToken = getOrderAccessToken();
  const mutation = `
    mutation refundTagsAdd($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        node { id }
        userErrors { field message }
      }
    }
  `;

  const payload = await adminGraphql(
    mutation,
    { id: orderGid, tags },
    { accessToken, requestedQueryCost: 10 }
  );

  const errors = payload?.data?.tagsAdd?.userErrors || [];
  if (errors.length) {
    throw new Error(errors[0]?.message || 'Could not add Shopify order tags.');
  }
}

async function tagsRemove(orderGid, tags) {
  const accessToken = getOrderAccessToken();
  const mutation = `
    mutation refundTagsRemove($id: ID!, $tags: [String!]!) {
      tagsRemove(id: $id, tags: $tags) {
        node { id }
        userErrors { field message }
      }
    }
  `;

  const payload = await adminGraphql(
    mutation,
    { id: orderGid, tags },
    { accessToken, requestedQueryCost: 10 }
  );

  const errors = payload?.data?.tagsRemove?.userErrors || [];
  if (errors.length) {
    throw new Error(errors[0]?.message || 'Could not remove Shopify order tags.');
  }
}

async function setRefundMetafield(orderGid, record) {
  const accessToken = getOrderAccessToken();
  const payload = buildRefundPayload(record);
  const mutation = `
    mutation refundMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key }
        userErrors { field message }
      }
    }
  `;

  const result = await adminGraphql(
    mutation,
    {
      metafields: [
        {
          ownerId: orderGid,
          namespace: METAFIELD_NAMESPACE,
          key: METAFIELD_KEY,
          type: 'json',
          value: JSON.stringify(payload),
        },
      ],
    },
    { accessToken, requestedQueryCost: 10 }
  );

  const errors = result?.data?.metafieldsSet?.userErrors || [];
  if (errors.length) {
    throw new Error(errors[0]?.message || 'Could not update Shopify refund metafield.');
  }

  console.log('[SHOPIFY REFUND METHOD METAFIELD]', {
    orderGid,
    requestId: payload.refund_request_id,
    refundMethod: payload.refund_method,
    refundDestinationLabel: payload.refund_destination_label,
    refundStatus: payload.refund_status,
    requiresManualProviderRefund: payload.requires_manual_provider_refund,
    walletRefundRequested: payload.wallet_refund_requested,
  });
}

async function updateShopifyOrderNote(orderGid, record) {
  const accessToken = getOrderAccessToken();
  const existing = await fetchShopifyOrderRefundState(orderGid);
  const nextNote = upsertNoteBlock(existing?.note, buildRefundNoteBlock(record));

  const mutation = `
    mutation refundOrderUpdate($input: OrderInput!) {
      orderUpdate(input: $input) {
        order { id note }
        userErrors { field message }
      }
    }
  `;

  const payload = await adminGraphql(
    mutation,
    {
      input: {
        id: orderGid,
        note: nextNote,
      },
    },
    { accessToken, requestedQueryCost: 10 }
  );

  const errors = payload?.data?.orderUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors[0]?.message || 'Could not update Shopify order note.');
  }
}

async function syncRefundRequestToShopify(record) {
  if (!hasShopifyOrderAdminAccessToken()) {
    throw new Error('Missing SHOPIFY_ORDER_ADMIN_ACCESS_TOKEN for refund sync.');
  }

  const orderGid = await resolveShopifyOrderGid({
    shopifyOrderId: record.shopify_order_id,
    orderNumber: record.order_number || record.order_id,
  });

  if (!orderGid) {
    throw new Error('Could not resolve Shopify order for refund request.');
  }

  const existing = await fetchShopifyOrderRefundState(orderGid);
  const existingTags = normalizeTags(existing?.tags);
  const removableTags = ALL_REFUND_TAGS.filter((tag) => existingTags.includes(tag));
  if (removableTags.length) {
    await tagsRemove(orderGid, removableTags);
  }

  const nextTags = getTagsForRecord(record);
  await tagsAdd(orderGid, nextTags);
  await setRefundMetafield(orderGid, record);
  await updateShopifyOrderNote(orderGid, record);

  const destination = getRefundDestinationMeta(record);

  console.log('[SHOPIFY REFUND METHOD TAGGED]', {
    orderGid,
    orderNumber: record.order_number || record.order_id,
    requestId: record.request_id,
    refundMethod: record.refund_method,
    refundDestinationLabel: destination.refund_destination_label,
    refundStatus: record.status,
    tags: nextTags,
  });

  console.log('[SHOPIFY REFUND REQUEST TAGGED]', {
    orderGid,
    orderNumber: record.order_number || record.order_id,
    requestId: record.request_id,
    refundStatus: record.status,
    tags: nextTags,
  });

  return {
    shopify_order_gid: orderGid,
    shopify_synced: true,
    refund_destination_label: destination.refund_destination_label,
  };
}

function parseRefundMetafieldValue(rawValue) {
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    console.log('[REFUND STATUS SYNC]', { reason: 'invalid_metafield_json', error: error.message });
    return null;
  }
}

async function pullRefundStatusFromShopify(record) {
  const orderGid = await resolveShopifyOrderGid({
    shopifyOrderId: record.shopify_order_id,
    orderNumber: record.order_number || record.order_id,
  });

  if (!orderGid) {
    return record;
  }

  const shopifyOrder = await fetchShopifyOrderRefundState(orderGid);
  const metafield = parseRefundMetafieldValue(shopifyOrder?.metafield?.value);
  const shopifyStatus = safeString(metafield?.refund_status).toLowerCase();
  const shopifyUpdatedAt = safeString(metafield?.updated_at);
  const redisUpdatedAt = safeString(record.updated_at);

  if (!shopifyStatus || shopifyStatus === safeString(record.status).toLowerCase()) {
    return {
      ...record,
      refund_destination_label:
        safeString(metafield?.refund_destination_label) || record.refund_destination_label,
    };
  }

  if (shopifyUpdatedAt && redisUpdatedAt && new Date(shopifyUpdatedAt).getTime() < new Date(redisUpdatedAt).getTime()) {
    return record;
  }

  console.log('[REFUND STATUS SYNC]', {
    requestId: record.request_id,
    fromStatus: record.status,
    toStatus: shopifyStatus,
    source: 'shopify_metafield',
  });

  return {
    ...record,
    shopify_order_id: record.shopify_order_id || orderGid,
    status: shopifyStatus,
    refund_destination_label:
      safeString(metafield?.refund_destination_label) || record.refund_destination_label,
    updated_at: shopifyUpdatedAt || new Date().toISOString(),
    shopify_synced_at: new Date().toISOString(),
  };
}

module.exports = {
  BASE_TAG,
  REFUND_METHOD_TAGS,
  REFUND_STATUS_TAGS,
  buildRefundPayload,
  getRefundDestinationMeta,
  resolveShopifyOrderGid,
  syncRefundRequestToShopify,
  pullRefundStatusFromShopify,
};