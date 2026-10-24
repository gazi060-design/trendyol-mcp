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
  const server = new McpServer(
    { name: 'trendyol-marketplace-mcp', version: '1.4.0' },
    {
      instructions: [
        'STORE SELECTION RULES (mandatory):',
        '1. At the beginning of every new conversation/session involving this Trendyol MCP, ask the user which configured store they want to work with before performing any store-specific operation.',
        '2. Do not assume, reuse, or infer a store from another conversation/session. A store mentioned in the initial request does not replace the requirement to ask for store selection at session start.',
        '3. Use trendyol_list_stores when needed to present the available store aliases and display names.',
        '4. After the user explicitly selects a store, use that store consistently until the user explicitly changes it.',
        '5. Every assistant response related to this Trendyol MCP after store selection must begin with the selected store display name (for example: "MyBook: ...").',
        '6. If the requested store is ambiguous or not configured, ask the user to choose a valid configured store before calling store-specific tools.',
        '7. Never perform a write operation without the separate explicit confirmation required by the write tool, even when a store has already been selected.'
      ].join('\n')
    }
  );

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

  const claimIdField = z.string().uuid();
  const claimItemsField = z.array(z.string().uuid()).min(1).refine(ids => new Set(ids).size === ids.length, 'Duplicate claim item IDs');
  const claimPageFields = {
    store: storeField,
    page: z.number().int().min(0).default(0),
    size: z.number().int().min(1).max(200).default(50),
  };
  const listClaims = async (store: string, filters: Record<string, string | number | undefined>) => {
    const api = clientFor(config, store);
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value !== undefined) qs.set(key, String(value));
    return jsonText(await api.request('GET', api.sellerPath(`/integration/order/sellers/{sellerId}/claims?${qs}`)));
  };

  server.registerTool('trendyol_get_claims', {
    description: 'List return claims, not undelivered Returned shipment packages. Read-only. Follow totalPages using page to inspect all results. Dates are milliseconds; omit dates for pending-action checks.',
    inputSchema: z.object({
      ...claimPageFields,
      claimItemStatus: z.enum(['Created', 'WaitingInAction', 'WaitingFraudCheck', 'Accepted', 'Cancelled', 'Rejected', 'Unresolved', 'InAnalysis']).optional(),
      startDate: z.number().int().nonnegative().optional(),
      endDate: z.number().int().nonnegative().optional(),
      orderNumber: z.string().min(1).optional(),
    }).refine(v => v.startDate === undefined || v.endDate === undefined || v.startDate <= v.endDate, 'startDate must not exceed endDate')
  }, async ({ store, ...filters }) => listClaims(store, filters));

  server.registerTool('trendyol_get_waiting_claims', {
    description: 'List returns awaiting seller action (WaitingInAction) for one store. Read-only. Follow totalPages using page; counts are claim packages, not individual items. Does not accept or reject anything.',
    inputSchema: z.object(claimPageFields)
  }, async ({ store, ...filters }) => listClaims(store, { ...filters, claimItemStatus: 'WaitingInAction' }));

  server.registerTool('trendyol_get_claim', {
    description: 'Read a return claim by ID, including item status, reasons and customer notes.',
    inputSchema: z.object({ store: storeField, claimId: claimIdField })
  }, async ({ store, claimId }) => listClaims(store, { claimIds: claimId }));

  server.registerTool('trendyol_get_claim_issue_reasons', {
    description: 'Read current return rejection/analysis reasons. Reason 1651 cannot be used in the first 24 hours of WaitingInAction; 2101 requires a customer exchange request.',
    inputSchema: z.object({ store: storeField })
  }, async ({ store }) => jsonText(await clientFor(config, store).request('GET', '/integration/order/claim-issue-reasons')));

  const checkWaitingItems = async (api: TrendyolClient, claimId: string, ids: string[]) => {
    const result = await api.request<{ content?: Array<{ id: string; items?: Array<{ claimItems?: Array<{ id: string; claimItemStatus?: { name?: string } }> }> }> }>(
      'GET', api.sellerPath(`/integration/order/sellers/{sellerId}/claims?claimIds=${encodeURIComponent(claimId)}`));
    const claim = result.content?.find(c => c.id === claimId);
    const items = claim?.items?.flatMap(item => item.claimItems ?? []) ?? [];
    if (!ids.every(id => items.some(item => item.id === id && item.claimItemStatus?.name === 'WaitingInAction'))) {
      throw new Error('Every selected claim item must belong to this claim/store and currently be WaitingInAction. Read the claim again.');
    }
  };

  server.registerTool('trendyol_approve_claim_items', {
    description: 'Accept selected return items. WRITE; requires explicit user approval and a single-use confirmation. Rechecks WaitingInAction before writing.',
    inputSchema: z.object({ store: storeField, claimId: claimIdField, claimLineItemIdList: claimItemsField, ...approvalFields })
  }, async ({ store, confirmationId, approved, ...data }) => {
    const normalizedStore = getStore(config, store).alias;
    const guard = writeGuard('trendyol_approve_claim_items', { store: normalizedStore, ...data }, confirmationId, approved);
    if (guard.pending) return guard.result;
    const api = clientFor(config, normalizedStore);
    await checkWaitingItems(api, data.claimId, data.claimLineItemIdList);
    const result = await api.request('PUT', api.sellerPath(`/integration/order/sellers/{sellerId}/claims/${data.claimId}/items/approve`), { claimLineItemIdList: data.claimLineItemIdList, params: {} });
    return jsonText({ submitted: true, result, message: 'Approval submitted; read claim again for final status (fraud review may apply).' });
  });

  server.registerTool('trendyol_create_claim_issue', {
    description: 'Submit a return rejection/analysis request; this is not a final rejection. WRITE; explicit confirmation required. Evidence files are base64, max 5 MB each. Do not invent evidence or customer requests.',
    inputSchema: z.object({
      store: storeField, claimId: claimIdField, claimItemIdList: claimItemsField,
      claimIssueReasonId: z.number().int().positive(), description: z.string().trim().min(1).max(500),
      files: z.array(z.object({
        name: z.string().min(1).max(255).regex(/^[^/\\]+$/),
        mimeType: z.enum(['image/jpeg', 'image/png', 'application/pdf', 'image/tiff', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'video/mp4', 'video/quicktime']),
        base64: z.string().min(4).max(6990508).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
          .refine(v => Buffer.from(v, 'base64').length <= 5 * 1024 * 1024, 'File exceeds 5 MB'),
      })).max(5).default([]), ...approvalFields
    }).refine(v => [1651, 451, 2101].includes(v.claimIssueReasonId) || v.files.length > 0, 'Evidence files required for this reason')
  }, async ({ store, confirmationId, approved, ...data }) => {
    const normalizedStore = getStore(config, store).alias;
    const guard = writeGuard('trendyol_create_claim_issue', { store: normalizedStore, ...data }, confirmationId, approved);
    if (guard.pending) return guard.result;
    const api = clientFor(config, normalizedStore);
    await checkWaitingItems(api, data.claimId, data.claimItemIdList);
    const qs = new URLSearchParams({ claimIssueReasonId: String(data.claimIssueReasonId), claimItemIdList: data.claimItemIdList.join(','), description: data.description });
    const form = new FormData();
    for (const file of data.files) form.append('files', new Blob([new Uint8Array(Buffer.from(file.base64, 'base64'))], { type: file.mimeType }), file.name);
    const result = await api.request('POST', api.sellerPath(`/integration/order/sellers/{sellerId}/claims/${data.claimId}/issue?${qs}`), form);
    return jsonText({ submitted: true, result, message: 'Issue submitted; read claim again to track the decision.' });
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

  server.registerTool('trendyol_get_orders_stream', {
    description: 'Read shipment packages from a specific store with cursor-based order streaming. Read-only.',
    inputSchema: z.object({
      store: storeField,
      cursor: z.string().optional(),
      size: z.number().int().min(1).max(200).default(200),
      startDate: z.number().int().optional(),
      endDate: z.number().int().optional(),
      status: z.string().optional()
    })
  }, async ({ store, cursor, size, startDate, endDate, status }) => {
    const api = clientFor(config, store);
    const parsedPage = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
    const page = Number.isInteger(parsedPage) && parsedPage >= 0 ? parsedPage : 0;
    const qs = new URLSearchParams({ page: String(page), size: String(size) });
    if (startDate) qs.set('startDate', String(startDate));
    if (endDate) qs.set('endDate', String(endDate));
    if (status) qs.set('status', status);

    const result = await api.request('GET', api.sellerPath(`/integration/order/sellers/{sellerId}/v2/orders?${qs}`)) as Record<string, unknown>;
    const resultPage = typeof result.page === 'number' ? result.page : page;
    const totalPages = typeof result.totalPages === 'number' ? result.totalPages : undefined;
    const nextCursor = totalPages !== undefined && resultPage + 1 < totalPages ? String(resultPage + 1) : undefined;

    return jsonText({ ...result, cursor: String(resultPage), nextCursor });
  });

  server.registerTool('trendyol_get_customer_questions', {
    description: 'List customer product questions for a specific Trendyol store. Read-only. Without date filters Trendyol returns recent questions.',
    inputSchema: z.object({
      store: storeField,
      barcode: z.string().optional(),
      startDate: z.number().int().optional(),
      endDate: z.number().int().optional(),
      status: z.enum(['WAITING_FOR_ANSWER', 'ANSWERED', 'REJECTED', 'REPORTED']).optional(),
      orderByField: z.enum(['CreatedDate', 'LastModifiedDate']).default('CreatedDate'),
      orderByDirection: z.enum(['ASC', 'DESC']).default('DESC'),
      page: z.number().int().min(0).default(0),
      size: z.number().int().min(1).max(200).default(50)
    })
  }, async ({ store, barcode, startDate, endDate, status, orderByField, orderByDirection, page, size }) => {
    const api = clientFor(config, store);
    const qs = new URLSearchParams({
      page: String(page),
      size: String(size),
      orderByField,
      orderByDirection
    });
    if (barcode) qs.set('barcode', barcode);
    if (startDate !== undefined) qs.set('startDate', String(startDate));
    if (endDate !== undefined) qs.set('endDate', String(endDate));
    if (status) qs.set('status', status);

    return jsonText(await api.request('GET', api.sellerPath(`/integration/qna/sellers/{sellerId}/questions/filter?${qs}`)));
  });

  server.registerTool('trendyol_get_customer_question', {
    description: 'Read a single Trendyol customer question by question id. Read-only.',
    inputSchema: z.object({
      store: storeField,
      questionId: z.number().int().positive()
    })
  }, async ({ store, questionId }) => {
    const api = clientFor(config, store);
    return jsonText(await api.request('GET', api.sellerPath(`/integration/qna/sellers/{sellerId}/questions/${questionId}`)));
  });

  server.registerTool('trendyol_answer_customer_question', {
    description: 'Answer a Trendyol customer question. WRITE operation; mandatory explicit confirmation. Answer text must be between 10 and 2000 characters.',
    inputSchema: z.object({
      store: storeField,
      questionId: z.number().int().positive(),
      text: z.string().min(10).max(2000),
      ...approvalFields
    })
  }, async ({ store, questionId, text, confirmationId, approved }) => {
    const normalizedStore = getStore(config, store).alias;
    const payload = { store: normalizedStore, questionId, text };
    const guard = writeGuard('trendyol_answer_customer_question', payload, confirmationId, approved);
    if (guard.pending) return guard.result;

    const api = clientFor(config, normalizedStore);
    return jsonText(await api.request(
      'POST',
      api.sellerPath(`/integration/qna/sellers/{sellerId}/questions/${questionId}/answers`),
      { text }
    ));
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
