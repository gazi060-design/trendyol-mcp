import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppConfig } from './config.js';
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

export function createMcpServer(config: AppConfig): McpServer {
  const server = new McpServer({ name: 'trendyol-marketplace-mcp', version: '1.1.0' });
  const api = new TrendyolClient(config);

  server.registerTool('trendyol_get_product', {
    description: 'Read seller products from Trendyol. Read-only.',
    inputSchema: z.object({ barcode: z.string().optional(), page: z.number().int().min(0).default(0), size: z.number().int().min(1).max(200).default(50) })
  }, async ({ barcode, page, size }) => {
    const qs = new URLSearchParams({ page: String(page), size: String(size) });
    if (barcode) qs.set('barcode', barcode);
    const path = api.sellerPath(`/integration/product/sellers/{sellerId}/products?${qs}`);
    return jsonText(await api.request('GET', path));
  });

  server.registerTool('trendyol_get_batch_result', {
    description: 'Read an asynchronous Trendyol batch result. Read-only.',
    inputSchema: z.object({ batchRequestId: z.string().min(1) })
  }, async ({ batchRequestId }) => jsonText(await api.request('GET', `/integration/product/batch-requests/${encodeURIComponent(batchRequestId)}`)));

  server.registerTool('trendyol_get_brands', {
    description: 'List Trendyol brands. Read-only.',
    inputSchema: z.object({ page: z.number().int().min(0).default(0), size: z.number().int().min(1).max(1000).default(100) })
  }, async ({ page, size }) => jsonText(await api.request('GET', `/integration/product/brands?page=${page}&size=${size}`)));

  server.registerTool('trendyol_find_brand', {
    description: 'Search Trendyol brands by name. Read-only.',
    inputSchema: z.object({ name: z.string().min(1), page: z.number().int().min(0).default(0), size: z.number().int().min(1).max(1000).default(100) })
  }, async ({ name, page, size }) => jsonText(await api.request('GET', `/integration/product/brands/by-name?name=${encodeURIComponent(name)}&page=${page}&size=${size}`)));

  server.registerTool('trendyol_get_categories', {
    description: 'List Trendyol product categories. Read-only.',
    inputSchema: z.object({})
  }, async () => jsonText(await api.request('GET', '/integration/product/product-categories')));

  server.registerTool('trendyol_get_category_attributes', {
    description: 'Read category attributes. Read-only.',
    inputSchema: z.object({ categoryId: z.number().int().positive() })
  }, async ({ categoryId }) => jsonText(await api.request('GET', `/integration/product/product-categories/${categoryId}/attributes`)));

  server.registerTool('trendyol_get_orders_stream', {
    description: 'Read shipment packages with cursor-based order streaming. Read-only.',
    inputSchema: z.object({ cursor: z.string().optional(), size: z.number().int().min(1).max(200).default(200), startDate: z.number().int().optional(), endDate: z.number().int().optional(), status: z.string().optional() })
  }, async ({ cursor, size, startDate, endDate, status }) => {
    const qs = new URLSearchParams({ size: String(size) });
    if (cursor) qs.set('cursor', cursor);
    if (startDate) qs.set('startDate', String(startDate));
    if (endDate) qs.set('endDate', String(endDate));
    if (status) qs.set('status', status);
    const path = api.sellerPath(`/integration/order/sellers/{sellerId}/v2/shipment-packages?${qs}`);
    return jsonText(await api.request('GET', path));
  });

  server.registerTool('trendyol_create_products', {
    description: 'Create products. WRITE operation; mandatory explicit confirmation.',
    inputSchema: z.object({ items: z.array(z.record(z.unknown())).min(1).max(1000), ...approvalFields })
  }, async ({ items, confirmationId, approved }) => {
    const payload = { items };
    const guard = writeGuard('trendyol_create_products', payload, confirmationId, approved);
    if (guard.pending) return guard.result;
    return jsonText(await api.request('POST', api.sellerPath('/integration/product/sellers/{sellerId}/v2/products'), payload));
  });

  server.registerTool('trendyol_update_stock_price', {
    description: 'Update product stock and/or price. WRITE operation; mandatory explicit confirmation.',
    inputSchema: z.object({ items: z.array(z.record(z.unknown())).min(1).max(1000), ...approvalFields })
  }, async ({ items, confirmationId, approved }) => {
    const payload = { items };
    const guard = writeGuard('trendyol_update_stock_price', payload, confirmationId, approved);
    if (guard.pending) return guard.result;
    return jsonText(await api.request('POST', api.sellerPath('/integration/inventory/sellers/{sellerId}/products/price-and-inventory'), payload));
  });

  server.registerTool('trendyol_update_product_content', {
    description: 'Update product content. WRITE operation; mandatory explicit confirmation.',
    inputSchema: z.object({ items: z.array(z.record(z.unknown())).min(1).max(1000), ...approvalFields })
  }, async ({ items, confirmationId, approved }) => {
    const payload = { items };
    const guard = writeGuard('trendyol_update_product_content', payload, confirmationId, approved);
    if (guard.pending) return guard.result;
    return jsonText(await api.request('PUT', api.sellerPath('/integration/product/sellers/{sellerId}/v2/products'), payload));
  });

  server.registerTool('trendyol_update_product_variants', {
    description: 'Update product variants. WRITE operation; mandatory explicit confirmation.',
    inputSchema: z.object({ items: z.array(z.record(z.unknown())).min(1).max(1000), ...approvalFields })
  }, async ({ items, confirmationId, approved }) => {
    const payload = { items };
    const guard = writeGuard('trendyol_update_product_variants', payload, confirmationId, approved);
    if (guard.pending) return guard.result;
    return jsonText(await api.request('PUT', api.sellerPath('/integration/product/sellers/{sellerId}/v2/products/variants'), payload));
  });

  server.registerTool('trendyol_update_delivery_info', {
    description: 'Update product delivery information. WRITE operation; mandatory explicit confirmation.',
    inputSchema: z.object({ items: z.array(z.record(z.unknown())).min(1).max(1000), ...approvalFields })
  }, async ({ items, confirmationId, approved }) => {
    const payload = { items };
    const guard = writeGuard('trendyol_update_delivery_info', payload, confirmationId, approved);
    if (guard.pending) return guard.result;
    return jsonText(await api.request('PUT', api.sellerPath('/integration/product/sellers/{sellerId}/products/delivery-information'), payload));
  });

  return server;
}
