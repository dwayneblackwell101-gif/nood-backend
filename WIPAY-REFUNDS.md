# WiPay refund setup

1. Apply supabase-wipay-refunds-migration.sql after the existing refund schema.
2. WiPay Developer → WAPI Keys: create a server-only key with
   wapi-transactions-retrieve and wapi-transactions-refund-request.
3. Store the live key as WIPAY_WAPI_KEY on the existing Render backend.
   WIPAY_API_KEY is a different payment-response credential and cannot be reused.
4. Register a Payments API webhook endpoint at
   https://nood-backend.onrender.com/webhooks/wipay/refunds/live
   for payment.refund_requested, payment.refunded, payment.refund_rejected.
   Store its signing secret as WIPAY_WEBHOOK_SECRET.
5. Sandbox uses merchant-owned sandbox credentials, WIPAY_WAPI_SANDBOX_KEY,
   WIPAY_SANDBOX_WEBHOOK_SECRET, and the /sandbox webhook endpoint.
   The shared public account 1234567890 cannot be retrieved/refunded with a
   live merchant's credentials and does not send that merchant's webhooks.

After support approves a full original-payment refund, the existing admin
update endpoint with status refunded_to_original submits the WiPay request.
HTTP 202 / customer status approved means processing, not refunded. Only a
correctly signed payment.refunded event completes it and records the external
refund in Shopify. Shopify does not send a second payment. The documented
WiPay endpoint takes no partial amount, so partial refunds remain manual.

The transaction ledger is written before the provider POST. Timeouts, restarts,
and replays never automatically repeat it. UNKNOWN/SUBMITTING entries need
WiPay reconciliation; do not delete them to retry. Rejected requests remain
manual review. A different request cannot refund the same transaction or
credit the wallet while its card refund is pending.

Webhook signatures verify the exact raw body, HMAC-SHA256, version v1, and a
five-minute timestamp window. Delivery IDs are stored; failed Shopify sync
returns non-2xx for retry. No credentials or full customer webhook bodies are
logged or stored in the event ledger.

Official references:
- https://docs.wipayfinancial.com/wapi/transactions/createRefundRequest
- https://docs.wipayfinancial.com/wapi/keys
- https://docs.wipayfinancial.com/webhooks
- https://docs.wipayfinancial.com/platforms-and-environments
