import { fetchBackendJson } from './backend';
import {
  mergeLocalAndShopifyOrders,
  type CustomerOrder,
} from './customer-orders';

type ShopifyOrdersResponse = {
  ok?: boolean;
  success?: boolean;
  orders?: CustomerOrder[];
  message?: string;
};

export type ShopifyOrdersSyncResult = {
  synced: boolean;
  orders: CustomerOrder[];
  message?: string;
};

export async function fetchShopifyCustomerOrders(params: {
  email: string;
  shopifyCustomerId?: string;
  limit?: number;
}): Promise<CustomerOrder[]> {
  const email = String(params.email || '').trim();
  if (!email) {
    return [];
  }

  try {
    const query = new URLSearchParams({
      email,
      limit: String(params.limit || 50),
    });

    if (params.shopifyCustomerId) {
      query.set('customerId', params.shopifyCustomerId);
    }

    const data = await fetchBackendJson<ShopifyOrdersResponse>(
      `/api/customer/orders?${query.toString()}`,
      { timeoutMs: 20000 }
    );

    if (!data || data.ok === false || data.success === false) {
      return [];
    }

    return Array.isArray(data.orders) ? data.orders : [];
  } catch (error) {
    console.log('[NOOD orders] Shopify sync unavailable:', error);
    return [];
  }
}

export async function syncCustomerOrdersWithShopify(params: {
  localOrders: CustomerOrder[];
  email: string;
  shopifyCustomerId?: string;
}): Promise<ShopifyOrdersSyncResult> {
  const email = String(params.email || '').trim();
  if (!email) {
    return {
      synced: false,
      orders: params.localOrders,
      message: 'missing-email',
    };
  }

  const shopifyOrders = await fetchShopifyCustomerOrders({
    email,
    shopifyCustomerId: params.shopifyCustomerId,
  });

  if (!shopifyOrders.length) {
    return {
      synced: false,
      orders: params.localOrders,
      message: 'no-shopify-orders',
    };
  }

  const mergedOrders = mergeLocalAndShopifyOrders(params.localOrders, shopifyOrders);

  mergedOrders.forEach((order) => {
    const financialStatus = String(order.displayFinancialStatus || order.financialStatus || '')
      .trim()
      .toUpperCase();
    const refundedAmount = Number(order.refundedAmount || 0);

    if (
      financialStatus === 'REFUNDED' ||
      financialStatus === 'PARTIALLY_REFUNDED' ||
      refundedAmount > 0
    ) {
      console.log('[ORDER REFUND STATUS SYNC]', {
        orderId: order.id,
        shopifyOrderId: order.shopifyOrderId,
        displayFinancialStatus: order.displayFinancialStatus || order.financialStatus,
        status: order.status,
        refundedAmount,
        refundRecordCount: Array.isArray(order.refundRecords) ? order.refundRecords.length : 0,
      });
    }
  });

  return {
    synced: true,
    orders: mergedOrders,
    message: 'synced',
  };
}