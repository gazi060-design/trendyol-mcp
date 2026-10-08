# Trendyol Marketplace MCP (Docker)

Dockerized MCP server for Trendyol Marketplace APIs, focused on Product V2 and cursor-based order synchronization.

## Included MCP tools

- `trendyol_get_product`
- `trendyol_create_products`
- `trendyol_update_stock_price`
- `trendyol_get_batch_result`
- `trendyol_get_orders_stream`
- `trendyol_get_brands`
- `trendyol_find_brand`
- `trendyol_get_categories`
- `trendyol_get_category_attributes`
- `trendyol_update_product_content`
- `trendyol_update_product_variants`
- `trendyol_update_delivery_info`

## Run

```bash
cp .env.example .env
# Fill Trendyol credentials and change MCP_API_TOKEN.
docker compose up -d --build
```

Health:

```bash
curl http://localhost:3000/health
```

MCP URL:

```text
http://localhost:3000/mcp
```

When `MCP_API_TOKEN` is set, send:

```text
Authorization: Bearer <MCP_API_TOKEN>
```

## Environment

```env
TRENDYOL_SELLER_ID=123456
TRENDYOL_API_KEY=...
TRENDYOL_API_SECRET=...
TRENDYOL_ENV=production
TRENDYOL_USER_AGENT=123456-SelfIntegration
MCP_PORT=3000
MCP_API_TOKEN=change-me
```

Set `TRENDYOL_ENV=stage` to use `https://stageapigw.trendyol.com`.

## Example Docker MCP configuration

For MCP clients that accept a remote Streamable HTTP endpoint, point them to:

```text
http://YOUR_SERVER:3000/mcp
```

and add the Bearer token header configured in `.env`.

## Notes

- Product create uses Product V2: `/integration/product/sellers/{sellerId}/v2/products`.
- Product creation is asynchronous; use `trendyol_get_batch_result` with the returned `batchRequestId`.
- Stock/price accepts up to 1000 items. Trendyol says identical requests must not be repeated within 15 minutes.
- Order streaming uses cursor pagination and supports up to 200 shipment packages per request.
- Keep this service private. Do not expose it directly to the public internet without TLS, authentication, and network restrictions.

## Mandatory confirmation for write operations

All tools that change Trendyol data use a two-phase confirmation flow.

1. Call the write tool without `approved` / `confirmationId`.
2. The server returns `requiresConfirmation: true`, a one-time `confirmationId`, an expiry timestamp, and a payload preview. **No Trendyol API write request is sent at this stage.**
3. The MCP client/assistant must show the proposed change to the user and ask for explicit approval.
4. Only after the user approves, call the exact same tool with the exact same payload plus:

```json
{
  "confirmationId": "<id returned by step 2>",
  "approved": true
}
```

Confirmation IDs expire after 5 minutes, are single-use, and are bound to the exact tool name and payload. If the payload changes, the confirmation is rejected and a new approval cycle is required.

This protection currently applies to:

- `trendyol_create_products`
- `trendyol_update_stock_price`
- `trendyol_update_product_content`
- `trendyol_update_product_variants`
- `trendyol_update_delivery_info`

Read-only tools do not require confirmation.

> Note: the server can enforce the two-phase technical handshake, but the final proof that a human actually clicked/typed approval depends on the MCP client. For production, use a client that surfaces tool confirmations to the user and does not auto-approve write tools.
