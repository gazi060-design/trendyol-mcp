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


## Connect to ChatGPT with OAuth (existing Nginx)

ChatGPT uses OAuth rather than a manually entered static Bearer token. This server
supports the MCP SDK authorization-code flow with S256 PKCE and dynamic client
registration (DCR). Only HTTPS callback URLs on `chatgpt.com` can be registered.
This is a private **single-owner** integration: authorizing a connection grants
access to all stores configured in `TRENDYOL_STORES_JSON`. It is not a multi-user
identity provider. Existing `MCP_API_TOKEN` clients continue to work.

1. Generate a separate owner login password locally:

   ```bash
   openssl rand -hex 32
   ```

2. Add these values to `.env`. Use the generated password, not the placeholder:

   ```env
   MCP_PUBLIC_URL=https://mcp.kigagu.com
   MCP_OAUTH_PASSWORD=<generated-password-at-least-32-characters>
   ```

   Both values must be set to enable OAuth. Leave both blank to disable it.
   Keep `MCP_API_TOKEN` configured for existing token-based clients. Never commit
   `.env` or paste any credentials into chat.

3. As the rootless Docker owner, deploy using the base Compose file:

   ```bash
   git pull
   docker compose -f docker-compose.yml up -d --build
   ```

   The MCP port is bound to `127.0.0.1`; the host Nginx proxies to
   `http://127.0.0.1:3000`. Use the existing TLS configuration and proxy **all**
   paths, including `/authorize`, `/token`, `/register`, `/revoke`,
   `/oauth/approve` and `/.well-known/`. Disable proxy buffering for MCP streams.
   HTTPS is terminated by the existing host Nginx; no additional proxy container is required.

4. Verify public discovery (no credentials needed):

   ```bash
   curl https://mcp.kigagu.com/.well-known/oauth-authorization-server
   curl https://mcp.kigagu.com/.well-known/oauth-protected-resource/mcp
   ```

5. In ChatGPT Plugins, select **+ → Add custom MCP server**. Enter
   `https://mcp.kigagu.com/mcp`, choose **OAuth**, and use **dynamic client
   registration / DCR**. Leave static client ID and client secret blank.
   Install the resulting plugin and connect your account. Enter
   `MCP_OAUTH_PASSWORD` only in the login form on `mcp.kigagu.com`, then approve.
   Use the installed plugin with `@` in a conversation.

OAuth access tokens expire after one hour. Refresh tokens expire after seven days
and rotate on use. Authorization codes are single-use and expire after one minute;
login requests expire after five minutes. The SDK validates S256 PKCE before token
exchange. Browser consent uses a Secure, HttpOnly, SameSite cookie and a CSRF token;
login attempts and OAuth endpoints are rate limited. Write tools retain their
separate payload-specific confirmation requirement.

The `oauth_data` Docker volume preserves registered clients and hashed tokens
across restarts. Do not delete this volume unless you intend to revoke connections.
Changing `MCP_OAUTH_PASSWORD` or `MCP_PUBLIC_URL` invalidates existing OAuth state;
remove and recreate the ChatGPT connection after such a change. Outside Docker,
set `MCP_OAUTH_STATE_FILE` to a private writable file to preserve state; without it,
state lives only in memory. Run one server replica with this state file.

## Validation

```bash
npm ci
npm test
```

Tests exercise actual HTTP OAuth discovery, registration, consent, PKCE rejection,
redirect/resource binding, replay rejection, refresh rotation, revocation and
restart persistence without calling any Trendyol API.
