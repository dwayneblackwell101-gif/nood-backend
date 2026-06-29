import { SHOPIFY_STORE_DOMAIN } from './shopify';

const CUSTOMER_API_DISCOVERY_URL = `https://${SHOPIFY_STORE_DOMAIN}/.well-known/customer-account-api`;

const CUSTOMER_PROFILE_QUERY = `
  query NoodCustomerProfile {
    customer {
      id
      firstName
      lastName
      emailAddress {
        emailAddress
      }
    }
  }
`;

const CUSTOMER_ORDERS_QUERY = `
  query NoodCustomerOrders($first: Int!) {
    customer {
      orders(first: $first, sortKey: PROCESSED_AT, reverse: true) {
        edges {
          node {
            id
            name
            processedAt
          }
        }
      }
    }
  }
`;

const CUSTOMER_ADDRESSES_QUERY = `
  query NoodCustomerAddresses($first: Int!) {
    customer {
      addresses(first: $first) {
        edges {
          node {
            id
            formatted
          }
        }
      }
    }
  }
`;

let cachedGraphqlEndpoint = '';

type GraphqlError = { message?: string };
type GraphqlResponse<T> = {
  data?: T;
  errors?: GraphqlError[];
};

export type ShopifyCustomerAccountProfile = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  displayName: string;
  orderCount: number;
  addressCount: number;
};

async function discoverCustomerAccountGraphqlEndpoint(): Promise<string> {
  if (cachedGraphqlEndpoint) {
    return cachedGraphqlEndpoint;
  }

  const response = await fetch(CUSTOMER_API_DISCOVERY_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Customer Account API discovery failed with ${response.status}.`);
  }

  const json = (await response.json()) as { graphql_api?: string };
  const endpoint = String(json.graphql_api || '').trim();

  if (!endpoint) {
    throw new Error('Customer Account API discovery did not return graphql_api.');
  }

  cachedGraphqlEndpoint = endpoint;
  return endpoint;
}

async function customerAccountGraphql<T>(
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<T | null> {
  const endpoint = await discoverCustomerAccountGraphqlEndpoint();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.log('[AUTH] Customer Account API request failed', response.status, body);
    return null;
  }

  const json = (await response.json()) as GraphqlResponse<T>;

  if (json.errors?.length) {
    console.log('[AUTH] Customer Account API GraphQL errors', json.errors);
    return null;
  }

  return json.data || null;
}

function buildDisplayName(firstName: string, lastName: string, email: string): string {
  const combined = `${firstName} ${lastName}`.trim();
  if (combined) {
    return combined;
  }

  if (email.includes('@')) {
    return email.split('@')[0];
  }

  return '';
}

export async function fetchShopifyCustomerAccountProfile(
  accessToken: string
): Promise<ShopifyCustomerAccountProfile | null> {
  const normalizedToken = String(accessToken || '').trim();
  if (!normalizedToken) {
    return null;
  }

  const [profileData, ordersData, addressesData] = await Promise.all([
    customerAccountGraphql<{
      customer?: {
        id?: string;
        firstName?: string;
        lastName?: string;
        emailAddress?: { emailAddress?: string };
      };
    }>(normalizedToken, CUSTOMER_PROFILE_QUERY),
    customerAccountGraphql<{
      customer?: {
        orders?: { edges?: Array<{ node?: { id?: string } }> };
      };
    }>(normalizedToken, CUSTOMER_ORDERS_QUERY, { first: 25 }),
    customerAccountGraphql<{
      customer?: {
        addresses?: { edges?: Array<{ node?: { id?: string } }> };
      };
    }>(normalizedToken, CUSTOMER_ADDRESSES_QUERY, { first: 25 }),
  ]);

  const customer = profileData?.customer;
  if (!customer?.id) {
    return null;
  }

  const firstName = String(customer.firstName || '').trim();
  const lastName = String(customer.lastName || '').trim();
  const email = String(customer.emailAddress?.emailAddress || '').trim();
  const orderCount = ordersData?.customer?.orders?.edges?.length || 0;
  const addressCount = addressesData?.customer?.addresses?.edges?.length || 0;

  return {
    id: String(customer.id),
    firstName,
    lastName,
    email,
    displayName: buildDisplayName(firstName, lastName, email),
    orderCount,
    addressCount,
  };
}