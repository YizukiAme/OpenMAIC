/**
 * Search Query Enhancer
 *
 * When a PDF is uploaded but the user requirement is too vague
 * (e.g. "讲讲这篇论文"), uses LLM to extract meaningful keywords
 * from the document text for a better web search query.
 */

import { callLLM } from '@/lib/ai/llm';
import { resolveModel, type ResolvedModel } from '@/lib/server/resolve-model';
import { createLogger } from '@/lib/logger';

const log = createLogger('QueryEnhancer');

/**
 * Enhance a search query using PDF text context.
 *
 * If pdfText is provided, uses a lightweight LLM call to extract
 * the document's title, key topics, and important terms, then
 * constructs a concise search query.
 *
 * Returns the original query if no PDF is available or if
 * enhancement fails.
 *
 * @param modelConfig - Optional model config for the LLM call.
 *   If not provided, uses server-configured default model.
 */
export async function enhanceSearchQuery(
  query: string,
  pdfText: string | undefined,
  modelConfig?: {
    modelString?: string;
    apiKey?: string;
    baseUrl?: string;
    providerType?: string;
    requiresApiKey?: boolean;
  },
): Promise<string> {
  if (!pdfText) return query;

  try {
    let resolved: ResolvedModel;
    try {
      resolved = resolveModel(modelConfig || {});
    } catch {
      log.warn('No model available for query enhancement, using original query');
      return query;
    }

    const snippet = pdfText.slice(0, 2000);

    const result = await callLLM(
      {
        model: resolved.model,
        messages: [
          {
            role: 'system',
            content:
              'You extract search keywords from documents. Return ONLY a concise search query string (under 200 characters), no explanation.',
          },
          {
            role: 'user',
            content: `The user uploaded a document and said: "${query}"

Extract the document's title, key topics, and important terms from the text below, then combine them into a concise web search query (under 200 characters) that would find relevant supplementary materials.

Document text (first 2000 chars):
${snippet}`,
          },
        ],
        maxOutputTokens: resolved.modelInfo?.outputWindow,
      },
      'enhance-search-query',
    );

    const enhanced = result.text.trim();
    if (enhanced && enhanced.length > 5 && enhanced.length <= 400) {
      log.info(`Enhanced search query: "${query}" → "${enhanced}"`);
      return enhanced;
    }
  } catch (e) {
    log.warn('Search query enhancement failed, using original query:', e);
  }

  return query;
}
