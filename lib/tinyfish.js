/**
 * The TinyFish search and fetch providers.
 *
 * TinyFish exposes two separate hosts rather than one base with paths:
 * `api.search.tinyfish.ai` answers a GET with the query in the query string,
 * and `api.fetch.tinyfish.ai` answers a POST with a JSON body. Both
 * authenticate with an `X-API-Key` header rather than a bearer token.
 *
 * @module dsh-web-dual-search/tinyfish
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

/** Stable id the TinyFish providers register under. */
export const TINYFISH_PROVIDER_ID = 'tinyfish';

/**
 * The query string for a search, skipping empty filters.
 *
 * @param params - the query and the optional filters.
 * @returns the encoded query string.
 */
function searchQueryString(params) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '') continue;
        search.set(key, String(value));
    }
    return search.toString();
}

/**
 * The TinyFish search provider.
 *
 * TinyFish's search response carries `results[]` of `{position, site_name,
 * title, snippet, description, url, date, publisher}`. The field names happen
 * to match the seam's vocabulary closely: `snippet` is the seam's snippet,
 * and `description` is the longer excerpt the seam calls a summary.
 */
export class TinyfishSearchProvider {
    /** Stable id this provider registers under. */
    id = TINYFISH_PROVIDER_ID;
    /**
     * @param resolveOptions - the options for the NEXT search, read once per search.
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
        return options.credentialAvailable && URL.canParse(options.searchBase);
    }

    /**
     * Whether a search can authenticate.
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
                'TinyFish',
                'Run \'tinyfish auth login\' to save one locally, export TINYFISH_API_KEY, or set the plugin\'s tinyfish.apiKeyEnv.'
            );
        }
        const params = {
            query: request.query,
            ...(options.maxResults === undefined ? {} : { max_results: options.maxResults })
        };
        const url = options.searchBase.replace(/\/+$/u, '') + '?' + searchQueryString(params);
        const payload = await withRetry(
            async () => await callApi(url, {
                headers: { 'X-API-Key': key },
                method: 'GET',
                signal
            }),
            {
                attempts: options.attempts,
                delayMs: options.retryDelayMs,
                signal,
                // TinyFish occasionally answers a valid query with no results.
                // A second attempt is cheap and the endpoint is free.
                retryWhen: value => !isRecord(value) || !Array.isArray(value.results) || value.results.length === 0
            }
        );
        const rows = isRecord(payload) && Array.isArray(payload.results) ? payload.results : [];
        const sources = [];
        for (const row of rows) {
            if (!isRecord(row)) continue;
            const url = absoluteHttpUrl(row.url);
            if (url === undefined) continue;
            const snippet = boundText(row.snippet, options.snippetMaxChars);
            const summary = boundText(row.description, options.summaryMaxChars);
            const publishedAt = toIsoDate(row.date);
            sources.push({
                url,
                ...(typeof row.title === 'string' && row.title.length > 0 ? { title: row.title } : {}),
                ...(snippet === undefined ? {} : { snippet }),
                ...(summary === undefined ? {} : { summary }),
                ...(publishedAt === undefined ? {} : { publishedAt })
            });
        }
        return { sources, truncated: false };
    }
}

/**
 * The TinyFish fetch provider.
 *
 * The endpoint takes `{urls: [...], format: "markdown"}` and answers with
 * `results[]` of `{url, final_url, title, text, published_date, latency_ms}`
 * plus `errors[]` of `{url, error, status}`.
 */
export class TinyfishFetchProvider {
    /** Stable id this provider registers under. */
    id = TINYFISH_PROVIDER_ID;
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
        return options.credentialAvailable && URL.canParse(options.fetchBase);
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
                'TinyFish',
                'Run \'tinyfish auth login\' to save one locally, export TINYFISH_API_KEY, or set the plugin\'s tinyfish.apiKeyEnv.'
            );
        }
        const payload = await withRetry(
            async () => await callApi(options.fetchBase.replace(/\/+$/u, ''), {
                headers: { 'X-API-Key': key },
                method: 'POST',
                body: { urls: [request.url], format: 'markdown' },
                signal
            }),
            { attempts: options.attempts, delayMs: options.retryDelayMs, signal }
        );
        const rows = isRecord(payload) && Array.isArray(payload.results) ? payload.results : [];
        const failures = isRecord(payload) && Array.isArray(payload.errors) ? payload.errors : [];
        const target = absoluteHttpUrl(request.url);
        const page = rows.find(row => isRecord(row) && absoluteHttpUrl(row.final_url ?? row.url) === target)
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
        const content = typeof page.text === 'string' ? page.text : '';
        const bounded = boundText(content, options.bodyMaxChars);
        return {
            url: absoluteHttpUrl(page.final_url ?? page.url) ?? request.url,
            statusCode: 200,
            body: { kind: 'text', content: bounded ?? '' },
            truncated: bounded !== undefined && content.length > bounded.length
        };
    }
}
