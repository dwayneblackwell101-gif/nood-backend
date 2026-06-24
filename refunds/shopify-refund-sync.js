const { adminGraphql } = require('../catalog/shopify');
const {
  getShopifyOrderAccessToken,
  hasShopifyOrderAdminAccessToken,
} = require('../shopify-order-access');

const METAFIELD_NAMESPACE = 'nood';
const METAFIELD_KEY = 'refund_request';
const BASE_TAG = 'refund-requested';

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

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
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

function buildRefundPayload(record) {
  return {
    refund_request_id: safeString(record.request_id),
    refund_status: safeString(record.status, 'pending_review'),
    refund_reason: safeString(record.reason),
    refund_method: safeString(record.refund_method),
    refund_amount: String(Number(record.amount || 0)),
    refund_currency: safeString(record.currency, 'TTD'),
    refund_items: Array.isArray(record.items) ? record.items : [],
    request_date: safeString(record.created_at || record.updated_at),
    customer_email: safeString(record.customer_email),
    order_number: safeString(record.order_number),
    notes: safeString(record.notes),
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
    `refund_request_id: ${payload.refund_request_id}`,
    `refund_status: ${payload.refund_status}`,
    `refund_reason: ${payload.refund_reason}`,
    `refund_method: ${payload.refund_method}`,
    `refund_amount: ${payload.refund_amount} ${payload.refund_currency}`,
    `refund_items: ${itemsSummary || 'n/a'}`,
    `request_date: ${payload.request_date}`,
    `updated_at: ${payload.updated_at}`,
  ].join('\n');
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

  console.log('[SHOPIFY REFUND METAFIELD UPDATED]', {
    orderGid,
    requestId: payload.refund_request_id,
    refundStatus: payload.refund_status,
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

function getTagsForStatus(status) {
  const statusTag = REFUND_STATUS_TAGS[safeString(status, 'pending_review')] || REFUND_STATUS_TAGS.pending_review;
  return [BASE_TAG, statusTag];
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
  const removableTags = ALL_STATUS_TAGS.filter((tag) => existingTags.includes(tag));
  if (removableTags.length) {
    await tagsRemove(orderGid, removableTags);
  }

  await tagsAdd(orderGid, getTagsForStatus(record.status));
  await setRefundMetafield(orderGid, record);
  await updateShopifyOrderNote(orderGid, record);

  console.log('[SHOPIFY REFUND REQUEST TAGGED]', {
    orderGid,
    orderNumber: record.order_number || record.order_id,
    requestId: record.request_id,
    refundStatus: record.status,
    tags: getTagsForStatus(record.status),
  });

  return {
    shopify_order_gid: orderGid,
    shopify_synced: true,
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
    return record;
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
    updated_at: shopifyUpdatedAt || new Date().toISOString(),
    shopify_synced_at: new Date().toISOString(),
  };
}

module.exports = {
  BASE_TAG,
  REFUND_STATUS_TAGS,
  buildRefundPayload,
  resolveShopifyOrderGid,
  syncRefundRequestToShopify,
  pullRefundStatusFromShopify,
};