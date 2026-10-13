import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import { getStore } from './config.js';
import { TrendyolClient } from './trendyol-client.js';

const jsonText = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
});

const storeField = z.string().min(1).describe('Trendyol store alias configured in TRENDYOL_STORES_JSON');

type QuestionPage = {
  content?: unknown[];
  page?: number;
  size?: number;
  totalElements?: number;
  totalPages?: number;
};

export function registerOrderQuestionTools(server: McpServer, config: AppConfig): void {
  server.registerTool('trendyol_get_order_questions', {
    description: 'List order-related Trendyol customer questions for a specific store. Read-only. Trendyol does not document a separate order-question API, so this tool derives order questions from the official Q&A feed by selecting private questions (public=false).',
    inputSchema: z.object({
      store: storeField,
      startDate: z.number().int().optional(),
      endDate: z.number().int().optional(),
      status: z.enum(['WAITING_FOR_ANSWER', 'ANSWERED', 'REJECTED', 'REPORTED']).optional(),
      orderByField: z.enum(['CreatedDate', 'LastModifiedDate']).default('CreatedDate'),
      orderByDirection: z.enum(['ASC', 'DESC']).default('DESC'),
      page: z.number().int().min(0).default(0),
      size: z.number().int().min(1).max(200).default(50)
    })
  }, async ({ store, startDate, endDate, status, orderByField, orderByDirection, page, size }) => {
    const selectedStore = getStore(config, store);
    const api = new TrendyolClient(config, selectedStore);

    const fetchPage = async (sourcePage: number): Promise<QuestionPage> => {
      const qs = new URLSearchParams({
        page: String(sourcePage),
        size: '200',
        orderByField,
        orderByDirection
      });
      if (startDate !== undefined) qs.set('startDate', String(startDate));
      if (endDate !== undefined) qs.set('endDate', String(endDate));
      if (status) qs.set('status', status);

      return await api.request(
        'GET',
        api.sellerPath(`/integration/qna/sellers/{sellerId}/questions/filter?${qs}`)
      ) as QuestionPage;
    };

    const first = await fetchPage(0);
    const sourceTotalPages = Math.max(1, first.totalPages ?? 1);
    const allQuestions: unknown[] = [...(first.content ?? [])];

    for (let sourcePage = 1; sourcePage < sourceTotalPages; sourcePage += 1) {
      const next = await fetchPage(sourcePage);
      allQuestions.push(...(next.content ?? []));
    }

    const orderQuestions = allQuestions.filter((question) => {
      return typeof question === 'object'
        && question !== null
        && (question as Record<string, unknown>).public === false;
    });

    const offset = page * size;
    const content = orderQuestions.slice(offset, offset + size);
    const totalElements = orderQuestions.length;
    const totalPages = totalElements === 0 ? 0 : Math.ceil(totalElements / size);

    return jsonText({
      content,
      page,
      size,
      totalElements,
      totalPages,
      sourcePagesScanned: sourceTotalPages,
      derivedFrom: 'Trendyol Q&A questions/filter (public=false)'
    });
  });
}
