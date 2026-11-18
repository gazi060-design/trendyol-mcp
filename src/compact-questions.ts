import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import { getStore } from './config.js';
import { TrendyolClient } from './trendyol-client.js';

/**
 * Low-token, read-only Q&A polling. Pagination is over the ORIGINAL Trendyol
 * feed (not the filtered subset), so an empty private-question page does not
 * imply there are no more pages. The caller must follow nextPage until null.
 * No process-local checkpoint: callers can safely persist their own cursor.
 */
export function registerCompactQuestionTools(server: McpServer, config: AppConfig): void {
  server.registerTool('trendyol_poll_pending_questions', {
    description: 'Preferred low-token read-only polling for unanswered questions. Returns one bounded SOURCE page, minimal fields, and nextPage. Continue until nextPage=null even if questions=[]; stop if first page has nextPage=null and questions=[]. For order-like questions use privateOnly=true, but private=false is NOT authoritative proof of order linkage. Call details only when necessary. Does not answer questions.',
    inputSchema: z.object({
      store: z.string().min(1),
      page: z.number().int().nonnegative().default(0),
      size: z.number().int().min(1).max(200).default(100),
      startDate: z.number().int().nonnegative().optional().describe('Optional Unix timestamp in milliseconds; use a persisted checkpoint with overlap, if available.'),
      endDate: z.number().int().nonnegative().optional(),
      privateOnly: z.boolean().default(false),
    }).refine(v => v.startDate === undefined || v.endDate === undefined || v.startDate <= v.endDate,
      'startDate must be <= endDate'),
  }, async ({ store, page, size, startDate, endDate, privateOnly }) => {
    const selected = getStore(config, store);
    const api = new TrendyolClient(config, selected);
    const qs = new URLSearchParams({
      page: String(page),
      size: String(size),
      status: 'WAITING_FOR_ANSWER',
      orderByField: 'CreatedDate',
      orderByDirection: 'DESC',
    });
    if (startDate !== undefined) qs.set('startDate', String(startDate));
    if (endDate !== undefined) qs.set('endDate', String(endDate));
    type Page = { content?: unknown[]; page?: number; totalPages?: number; totalElements?: number };
    const result = await api.request<Page>('GET', api.sellerPath(
      `/integration/qna/sellers/{sellerId}/questions/filter?${qs}`
    ));
    if (!result || !Array.isArray(result.content)) throw new Error('Invalid Trendyol Q&A page: content must be an array');
    const currentPage = Number.isInteger(result.page) && (result.page ?? -1) >= 0 ? result.page! : page;
    const totalPages = Number.isInteger(result.totalPages) && (result.totalPages ?? -1) >= 0
      ? result.totalPages! : undefined;
    // Do not claim exhaustion if Trendyol fails to provide pagination metadata.
    const hasMore = totalPages === undefined ? result.content.length === size : currentPage + 1 < totalPages;
    const questions = result.content
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
      .filter(item => !privateOnly || item.public === false)
      .map(item => {
        const answer = item.answer as Record<string, unknown> | undefined;
        return {
          id: item.id,
          text: item.text ?? item.question,
          barcode: item.barcode ?? item.productBarcode,
          productName: item.productName,
          createdDate: item.createdDate,
          status: item.status,
          public: item.public,
          answerPresent: Boolean(answer && Object.keys(answer).length),
        };
      });
    const payload = {
      store: selected.alias,
      questions,
      sourcePage: currentPage,
      nextPage: hasMore ? currentPage + 1 : null,
      totalPages: totalPages ?? null,
      totalElements: result.totalElements ?? null,
      returned: questions.length,
      empty: questions.length === 0,
      filter: privateOnly ? 'private questions only (heuristic)' : 'all unanswered questions',
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  });
}
