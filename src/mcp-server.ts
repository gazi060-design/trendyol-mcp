import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import { getStore } from './config.js';
import { TrendyolClient } from './trendyol-client.js';
import { consumeConfirmation, requestConfirmation } from './confirmation-store.js';

const jsonText = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });

function writeGuard(toolName: string, payload: unknown, confirmationId?: string, approved?: boolean) {
  if (!approved || !confirmationId) {
    const confirmation = requestConfirmation(toolName, payload);
    return {
      pending: true as const,
      result: jsonText({
        requiresConfirmation: true,
        ...confirmation,
        tool: toolName,
        payloadPreview: payload,
        message: 'No Trendyol write request was sent. Ask the user for explicit approval, then repeat the same tool call with approved=true and confirmationId.'
      })
    };
  }

  const consumed = consumeConfirmation(toolName, payload, confirmationId, approved);
  if (!consumed.ok) {
    return {
      pending: true as const,
      result: { ...jsonText({ requiresConfirmation: true, error: consumed.reason }), isError: true }
    };
  }

  return { pending: false as const };
}

const approvalFields = {
  confirmationId: z.string().uuid().optional().describe('One-time confirmation id returned by the first call'),
  approved: z.boolean().optional().describe('Must be true only after explicit user approval'),
};

const storeField = z.string().min(1).describe('Trendyol store alias configured in TRENDYOL_STORES_JSON');

function clientFor(config: AppConfig, alias: string) {
  return new TrendyolClient(config, getStore(config, alias));
}

export function createMcpServer(config: AppConfig): McpServer {
  const server = new McpServer({ name: 'trendyol-marketplace-mcp', version: '1.2.0' });

  server.registerTool('trendyol_list_stores', {
    description: 'List configured Trendyol store aliases and display names. Never exposes API keys or secrets.',
    inputSchema: z.object({})
  }, async () => jsonText({
    stores: Object.values(config.stores).map((store) => ({ alias: store.alias, name: store.name ?? store.alias, sellerId: store.sellerId }))
  }));

  server.registerTool('trendyol_get_product', {
    description: 'Read seller products from a specific Trendyol store. Read-only.',
    inputSchema: z.object({ store: storeField, barcode: z.string().optional(), page: z.number().int().min(0).default(0), size: z.number().int().min(1).max(200).default(50) })
  }, async ({ store, barcode, page, size }) => {
    const api = clientFor(config, store);
    const qs = new URLSearchParams({ page: String(page), size: String(size) });
    if (barcode) qs.set('barcode', barcode);
    return jsonText(await api.request('GET', api.sellerPath(`/integration/product/sellers/{sellerId}/products?${qs}`)));
  });

  server.registerTool('trendyol_get_batch_result', {
    description: 'Read an asynchronous Trendyol batch result. Read-only.',
    inputSchema: z.object({ store: storeField, batchRequestId: z.string().min(1) })
  }, async ({ store, batchRequestId }) => {
    const api = clientFor(config, store);
    return jsonText(await api.request('GET', `/integration/product/batch-requests/${encodeURIComponent(batchRequestId)}`));
  });

  server.registerTool('trendyol_get_brands', {
    description: 'List Trendyol brands. Read-only.',
    inputSchema: z.object({ store: storeField, page: z.number().int().min(0).default(0), size: z.number().int().min(1).max(1000).default(100) })
  }, async ({ store, page, size }) => {
    const api = clientFor(config, store);
    return jsonText(await api.request('GET', `/integration/product/brands?page=${page}&size=${size}`));
  });

  server.registerTool('trendyol_find_brand', {
    description: 'Search Trendyol brands by name. Read-only.',
    inputSchema: z.object({ store: storeField, name: z.string().min(1), page: z.number().int().min(0).default(0), size: z.number().int().min(1).max(1000).default(100) })
  }, async ({ store, name, page, size }) => {
    const api = clientFor(config, store);
    return jsonText(await api.request('GET', `/integration/product/brands/by-name?name=${encodeURIComponent(name)}&page=${page}&size=${size}`));
  });

  server.registerTool('trendyol_get_categories', {
    description: 'List Trendyol product categories. Read-only.',
    inputSchema: z.object({ store: storeField })
  }, async ({ store }) => {
    const api = clientFor(config, store);
    return jsonText(await api.request('GET', '/integration/product/product-categories'));
  });

  server.registerTool('trendyol_get_category_attributes', {
    description: 'Read category attributes. Read-only.',
    inputSchema: z.object({ store: storeField, categoryId: z.number().int().positive() })
  }, async ({ store, categoryId }) => {
    const api = clientFor(config, store);
    return jsonText(await api.request('GET', `/integration/product/product-categories/${categoryId}/attributes`));
  });

  server.registerTool('trendyol_get_orders', {
    description: 'Read orders from a specific Trendyol store using the Order V2 endpoint. Read-only.',
    inputSchema: z.object({
      store: storeField,
      page: z.number().int().min(0).default(0),
      size: z.number().int().min(1).max(200).default(50),
      startDate: z.number().int().optional(),
      endDate: z.number().int().optional(),
      status: z.string().optional(),
      orderByField: z.string().optional(),
      orderByDirection: z.enum(['ASC', 'DESC']).optional()
    })
  }, async ({ store, page, size, startDate, endDate, status, orderByField, orderByDirection }) => {
    const api = clientFor(config, store);
    const qs = new URLSearchParams({ page: String(page), size: String(size) });
    if (startDate) qs.set('startDate', String(startDate));
    if (endDate) qs.set('endDate', String(endDate));
    if (status) qs.set('status', status);
    if (orderByField) qs.set('orderByField', orderByField);
    if (orderByDirection) qs.set('orderByDirection', orderByDirection);
    return jsonText(await api.request('GET', api.sellerPath(`/integration/order/sellers/{sellerId}/v2/orders?${qs}`)));
  });

  server.registerTool('trendyol_create_products', {
    description: 'Create products in the selected store. WRITE operation; mandatory explicit confirmation.',
    inputSchema: z.object({ store: storeField, items: z.array(z.record(z.unknown())).min(1).max(1000), ...approvalFields })
  }, async ({ store, items, confirmationId, approved }) => {
    const normalizedStore = getStore(config, store).alias;
    const payload = { store: normalizedStore, items };
    const guard = writeGuard('trendyol_create_products', payload, confirmationId, approved);
    if (guard.pending) return guard.result;
    const api = clientFor(config, normalizedStore);
    return jsonText(await api.request('POST', api.sellerPath('/integration/product/sellers/{sellerId}/v2/products'), { items }));
  });

  server.registerTool('trendyol_update_stock_price', {
    description: 'Update stock and/or price in the selected store. WRITE operation; mandatory explicit confirmation.',
    inputSchema: z.object({ store: storeField, items: z.array(z.record(z.unknown())).min(1).max(1000), ...approvalFields })
  }, async ({ store, items, confirmationId, approved }) => {
    const normalizedStore = getStore(config, store).alias;
    const payload = { store: normalizedStore, items };
    const guard = writeGuard('trendyol_update_stock_price', payload, confirmationId, approved);
    if (guard.pending) return guard.result;
    const api = clientFor(config, normalizedStore);
    return jsonText(await api.request('POST', api.sellerPath('/integration/inventory/sellers/{sellerId}/products/price-and-inventory'), { items }));
  });

  server.registerTool('trendyol_update_product_content', {
    description: 'Update product content in the selected store. WRITE operation; mandatory explicit confirmation.',
    inputSchema: z.object({ store: storeField, items: z.array(z.record(z.unknown())).min(1).max(1000), ...approvalFields })
  }, async ({ store, items, confirmationId, approved }) => {
    const normalizedStore = getStore(config, store).alias;
    const payload = { store: normalizedStore, items };
    const guard = writeGuard('trendyol_update_product_content', payload, confirmationId, approved);
    if (guard.pending) return guard.result;
    const api = clientFor(config, normalizedStore);
    return jsonText(await api.request('PUT', api.sellerPath('/integration/product/sellers/{sellerId}/v2/products'), { items }));
  });

  server.registerTool('trendyol_update_product_variants', {
    description: 'Update product variants in the selected store. WRITE operation; mandatory explicit confirmation.',
    inputSchema: z.object({ store: storeField, items: z.array(z.record(z.unknown())).min(1).max(1000), ...approvalFields })
  }, async ({ store, items, confirmationId, approved }) => {
    const normalizedStore = getStore(config, store).alias;
    const payload = { store: normalizedStore, items };
    const guard = writeGuard('trendyol_update_product_variants', payload, confirmationId, approved);
    if (guard.pending) return guard.result;
    const api = clientFor(config, normalizedStore);
    return jsonText(await api.request('PUT', api.sellerPath('/integration/product/sellers/{sellerId}/v2/products/variants'), { items }));
  });

  server.registerTool('trendyol_update_delivery_info', {
    description: 'Update product delivery information in the selected store. WRITE operation; mandatory explicit confirmation.',
    inputSchema: z.object({ store: storeField, items: z.array(z.record(z.unknown())).min(1).max(1000), ...approvalFields })
  }, async ({ store, items, confirmationId, approved }) => {
    const normalizedStore = getStore(config, store).alias;
    const payload = { store: normalizedStore, items };
    const guard = writeGuard('trendyol_update_delivery_info', payload, confirmationId, approved);
    if (guard.pending) return guard.result;
    const api = clientFor(config, normalizedStore);
    return jsonText(await api.request('PUT', api.sellerPath('/integration/product/sellers/{sellerId}/products/delivery-information'), { items }));
  });

  return server;
}
