/**
 * The Tavily search and fetch providers.
 *
 * Tavily's two endpoints do not match the seam's vocabulary, and that is the
 * whole reason this adapter exists:
 *
 * - `/search` answers with `results[]` of `{url, title, content, score,
 *   published_date, raw_content}`. The seam's source shape wants a
 *   `snippet`, so `content` (the provider's short excerpt) becomes the
 *   snippet and `raw_content` (the full page text) becomes the summary. A
 *   naive field-for-field mapping yields a source with no excerpt at all,
 *   because Tavily never sends a field named `snippet`.
 * - Tavily has no `/fetch` route. Page extraction lives at `/extract`, which
 *   takes `{urls: [...]}` and answers with `results[]` of `{url, title,
 *   raw_content}` plus `failed_results[]`.
 *
 * @module dsh-web-dual-search/tavily
 */
import {
    absoluteHttpUrl,
    boundText,
    callApi,
    isRecord,
    missingCredential,
    toIsoDate,
    withRetry
} from './shared.js';

/** Stable id the Tavily providers register under. */
export const TAVILY_PROVIDER_ID = 'tavily';

/**
 * The Tavily search provider.
 */
export class TavilySearchProvider {
    /** Stable id this provider registers under. */
    id = TAVILY_PROVIDER_ID;
    /**
     * @param resolveOptions - the options for the NEXT search, read once per search.
     */
    constructor(resolveOptions) {
        this.resolveOptions = resolveOptions;
    }

    /**
     * Cheap local usability check. Must not make network calls: the seam calls
     * this to choose between providers, and a network call here would turn
     * selection into a latency spike on every search.
     *
     * @returns whether a credential and a usable endpoint are both reachable.
     */
    available() {
        const options = this.resolveOptions();
        return options.credentialAvailable && URL.canParse(options.baseURL);
    }

    /**
     * Whether a search can authenticate. The seam consults this before it
     * exposes the tool, so a missing key surfaces as a missing tool rather
     * than as a failed call.
     *
     * @returns whether a credential resolves.
     */
    async ready() {
        const options = this.resolveOptions();
        return await options.resolveCredential() !== undefined;
    }

    /**
     * Run one search.
     *
     * @param request - the query and the result cap.
     * @param signal - cancellation.
     * @returns the normalized search outcome.
     */
    async search(request, signal) {
        const options = this.resolveOptions();
        const key = await options.resolveCredential();
        if (key === undefined) {
            throw missingCredential(
                'Tavily',
                'Save one through the harness credentials service, export TAVILY_API_KEY, or set the plugin\'s tavily.apiKeyEnv.'
            );
        }
        const count = Math.min(request.maxResults ?? options.count, options.count);
        const body = {
            query: request.query,
            max_results: count,
            include_answer: options.includeAnswer,
            ...(options.topic === undefined ? {} : { topic: options.topic }),
            ...(options.depth === undefined ? {} : { search_depth: options.depth }),
            ...(options.domains.length === 0 ? {} : { include_domains: options.domains }),
            ...(options.includeRawContent ? { include_raw_content: true } : {})
        };
        const payload = await withRetry(
            async () => await callApi(options.baseURL.replace(/\/+$/u, '') + '/search', {
                headers: { authorization: 'Bearer ' + key },
                method: 'POST',
                body,
                signal
            }),
            { attempts: options.attempts, delayMs: options.retryDelayMs, signal }
        );
        const rows = isRecord(payload) && Array.isArray(payload.results) ? payload.results : [];
        const sources = [];
        for (const row of rows) {
            if (!isRecord(row)) continue;
            const url = absoluteHttpUrl(row.url);
            if (url === undefined) continue;
            const snippet = boundText(row.content, options.snippetMaxChars);
            const summary = boundText(row.raw_content, options.summaryMaxChars);
            const publishedAt = toIsoDate(row.published_date);
            sources.push({
                url,
                ...(typeof row.title === 'string' && row.title.length > 0 ? { title: row.title } : {}),
                ...(snippet === undefined ? {} : { snippet }),
                ...(summary === undefined ? {} : { summary }),
                ...(publishedAt === undefined ? {} : { publishedAt })
            });
        }
        const answer = isRecord(payload) && typeof payload.answer === 'string' && payload.answer.trim().length > 0
            ? payload.answer.trim()
            : undefined;
        return {
            ...(answer === undefined ? {} : { content: answer }),
            sources,
            truncated: false
        };
    }
}

/**
 * The Tavily fetch provider.
 *
 * A page that could not be retrieved is reported as a result carrying the
 * provider's own outcome, not as a thrown error: the capability worked, and
 * the page is the thing that failed.
 */
export class TavilyFetchProvider {
    /** Stable id this provider registers under. */
    id = TAVILY_PROVIDER_ID;
    /**
     * @param resolveOptions - the options for the NEXT fetch, read once per fetch.
     */
    constructor(resolveOptions) {
        this.resolveOptions = resolveOptions;
    }

    /**
     * Cheap local usability check; no network calls.
     * @returns whether a credential and a usable endpoint are both reachable.
     */
    available() {
        const options = this.resolveOptions();
        return options.credentialAvailable && URL.canParse(options.baseURL);
    }

    /**
     * Whether a fetch can authenticate.
     * @returns whether a credential resolves.
     */
    async ready() {
        const options = this.resolveOptions();
        return await options.resolveCredential() !== undefined;
    }

    /**
     * Retrieve one URL as clean Markdown.
     *
     * @param request - the URL to retrieve.
     * @param signal - cancellation.
     * @returns the normalized fetch outcome.
     */
    async fetch(request, signal) {
        const options = this.resolveOptions();
        const key = await options.resolveCredential();
        if (key === undefined) {
            throw missingCredential(
                'Tavily',
                'Save one through the harness credentials service, export TAVILY_API_KEY, or set the plugin\'s tavily.apiKeyEnv.'
            );
        }
        const payload = await withRetry(
            async () => await callApi(options.baseURL.replace(/\/+$/u, '') + '/extract', {
                headers: { authorization: 'Bearer ' + key },
                method: 'POST',
                body: {
                    urls: [request.url],
                    extract_depth: options.depth === 'advanced' ? 'advanced' : 'basic'
                },
                signal
            }),
            { attempts: options.attempts, delayMs: options.retryDelayMs, signal }
        );
        const rows = isRecord(payload) && Array.isArray(payload.results) ? payload.results : [];
        const failures = isRecord(payload) && Array.isArray(payload.failed_results) ? payload.failed_results : [];
        const target = absoluteHttpUrl(request.url);
        const page = rows.find(row => isRecord(row) && absoluteHttpUrl(row.url) === target)
            ?? rows.find(row => isRecord(row));
        if (page === undefined) {
            const failure = failures.find(row => isRecord(row) && row.url === request.url)
                ?? failures.find(row => isRecord(row));
            const reason = failure !== undefined && typeof failure.error === 'string'
                ? failure.error
                : 'the provider returned no content';
            return {
                url: request.url,
                statusCode: 502,
                body: { kind: 'text', content: 'Could not retrieve this page: ' + reason + '.' },
                truncated: false
            };
        }
        const content = typeof page.raw_content === 'string' ? page.raw_content : '';
        const bounded = boundText(content, options.bodyMaxChars);
        return {
            url: absoluteHttpUrl(page.url) ?? request.url,
            statusCode: 200,
            body: { kind: 'text', content: bounded ?? '' },
            truncated: bounded !== undefined && content.length > bounded.length
        };
    }
}
