/**
 * Tavily and TinyFish web search/fetch providers for the DeepSeek Harness web
 * capability seam (`ctx.web`).
 *
 * One plugin, two backends. Each backend contributes a search provider and a
 * fetch provider; the seam resolves between them at call time, so search and
 * fetch can run on different backends, and the operator chooses by setting
 * `web.searchProvider` / `web.fetchProvider`.
 *
 * The two backends live behind one plugin rather than shipping as two: they
 * occupy the same slot in the seam's provider registry, and the seam's
 * fallback rule is "exactly one usable provider" — two separately-installed
 * plugins would make selection ambiguous whenever both credentials were
 * present. One plugin, two explicit ids, no ambiguity.
 *
 * @module dsh-web-dual-search
 */
import z from '@deepseek-ai/schemastery';
import { TavilyFetchProvider, TavilySearchProvider, TAVILY_PROVIDER_ID } from './tavily.js';
import { TinyfishFetchProvider, TinyfishSearchProvider, TINYFISH_PROVIDER_ID } from './tinyfish.js';
import { credentialAvailable, credentialResolver, providerConfigPath } from './shared.js';

/** The plugin's own identity — log lines and the settings namespace. */
export const name = 'dsh-web-dual-search';
/** The services this plugin needs. */
export const inject = ['web'];

/** Default Tavily API base; `/search` and `/extract` are appended. */
export const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com';
/** Default TinyFish search base; the query string is appended. */
export const TINYFISH_DEFAULT_SEARCH_BASE = 'https://api.search.tinyfish.ai';
/** Default TinyFish fetch base. */
export const TINYFISH_DEFAULT_FETCH_BASE = 'https://api.fetch.tinyfish.ai';

/**
 * The plugin's configuration.
 *
 * The two backends are configured independently: one deployment may run search
 * on Tavily and fetch on TinyFish, or the reverse, and either backend may be
 * left without a credential — a backend with no credential reports itself
 * unavailable, and the seam falls through to the other one.
 *
 * The nested objects are plain (not volatile) so that their children can be
 * volatile: a volatile field may not sit under an enclosing volatile field,
 * and the settings UI needs the leaf fields to be individually settable.
 */
export const Config = z.object({
    tavily: z.object({
        baseURL: z.string().default(TAVILY_DEFAULT_BASE_URL).volatile().description('Tavily API base URL.'),
        apiKey: z.string().role('secret').volatile().description('Literal Tavily credential; prefer a credential ref or the environment.'),
        apiKeyEnv: z.string().role('credential-ref').default('TAVILY_API_KEY').volatile().description('Credential ref or environment variable holding the Tavily key.'),
        count: z.number().step(1).min(1).max(50).default(10).volatile().description('Maximum results per search.'),
        includeAnswer: z.boolean().default(true).volatile().description('Ask Tavily for its generated answer text.'),
        includeRawContent: z.boolean().default(false).volatile().description('Ask Tavily for full page text, reported as each source\'s summary.'),
        topic: z.union([z.const('general'), z.const('news'), z.const('finance')]).default('general').volatile().description('Tavily search topic.'),
        depth: z.union([z.const('basic'), z.const('advanced')]).default('basic').volatile().description('Tavily search and extraction depth.'),
        domains: z.array(z.string().min(1)).default([]).volatile().description('Restrict search to these domains.'),
        snippetMaxChars: z.number().step(1).min(1).default(400).volatile().description('Maximum characters per source snippet.'),
        summaryMaxChars: z.number().step(1).min(1).default(2000).volatile().description('Maximum characters per source summary.'),
        bodyMaxChars: z.number().step(1).min(1).default(50000).volatile().description('Maximum characters of extracted page text.')
    }),
    tinyfish: z.object({
        searchBase: z.string().default(TINYFISH_DEFAULT_SEARCH_BASE).volatile().description('TinyFish search base URL.'),
        fetchBase: z.string().default(TINYFISH_DEFAULT_FETCH_BASE).volatile().description('TinyFish fetch base URL.'),
        apiKey: z.string().role('secret').volatile().description('Literal TinyFish credential; prefer a credential ref or the environment.'),
        apiKeyEnv: z.string().role('credential-ref').default('TINYFISH_API_KEY').volatile().description('Credential ref or environment variable holding the TinyFish key.'),
        maxResults: z.number().step(1).min(1).max(50).default(10).volatile().description('Maximum results per search.'),
        snippetMaxChars: z.number().step(1).min(1).default(400).volatile().description('Maximum characters per source snippet.'),
        summaryMaxChars: z.number().step(1).min(1).default(2000).volatile().description('Maximum characters per source summary.'),
        bodyMaxChars: z.number().step(1).min(1).default(50000).volatile().description('Maximum characters of extracted page text.')
    }),
    attempts: z.number().step(1).min(1).max(5).default(2).volatile().description('Attempts per request; transient failures are retried.'),
    retryDelayMs: z.number().step(0).default(500).volatile().description('Delay between attempts.')
});

/**
 * Register both backends' providers with the web seam.
 *
 * @param ctx - the plugin context.
 * @param config - the plugin's resolved configuration.
 */
export function apply(ctx, config) {
    const attempts = config.attempts.get();
    const retryDelayMs = config.retryDelayMs.get();

    const tavily = config.tavily;
    const tavilyFiles = [{ path: providerConfigPath('tavily', '.env'), field: 'api_key', envName: 'TAVILY_API_KEY' }];
    const tavilyCredential = credentialResolver(ctx, {
        literal: tavily.apiKey.get(),
        ref: tavily.apiKeyEnv.get(),
        files: tavilyFiles
    });
    const tavilyOptions = () => ({
        baseURL: tavily.baseURL.get(),
        resolveCredential: tavilyCredential,
        credentialAvailable: credentialAvailable(ctx, {
            literal: tavily.apiKey.get(),
            envNames: [tavily.apiKeyEnv.get(), 'TAVILY_API_KEY'],
            files: tavilyFiles
        }),
        count: tavily.count.get(),
        includeAnswer: tavily.includeAnswer.get(),
        includeRawContent: tavily.includeRawContent.get(),
        topic: tavily.topic.get(),
        depth: tavily.depth.get(),
        domains: tavily.domains.get(),
        snippetMaxChars: tavily.snippetMaxChars.get(),
        summaryMaxChars: tavily.summaryMaxChars.get(),
        bodyMaxChars: tavily.bodyMaxChars.get(),
        attempts,
        retryDelayMs
    });

    const tinyfish = config.tinyfish;
    const tinyfishFiles = [{ path: providerConfigPath('tinyfish', 'config.json'), field: 'api_key', envName: 'TINYFISH_API_KEY' }];
    const tinyfishCredential = credentialResolver(ctx, {
        literal: tinyfish.apiKey.get(),
        ref: tinyfish.apiKeyEnv.get(),
        files: tinyfishFiles
    });
    const tinyfishOptions = () => ({
        searchBase: tinyfish.searchBase.get(),
        fetchBase: tinyfish.fetchBase.get(),
        resolveCredential: tinyfishCredential,
        credentialAvailable: credentialAvailable(ctx, {
            literal: tinyfish.apiKey.get(),
            envNames: [tinyfish.apiKeyEnv.get(), 'TINYFISH_API_KEY'],
            files: tinyfishFiles
        }),
        maxResults: tinyfish.maxResults.get(),
        snippetMaxChars: tinyfish.snippetMaxChars.get(),
        summaryMaxChars: tinyfish.summaryMaxChars.get(),
        bodyMaxChars: tinyfish.bodyMaxChars.get(),
        attempts,
        retryDelayMs
    });

    ctx.web.registerSearchProvider(new TavilySearchProvider(tavilyOptions));
    ctx.web.registerFetchProvider(new TavilyFetchProvider(tavilyOptions));
    ctx.web.registerSearchProvider(new TinyfishSearchProvider(tinyfishOptions));
    ctx.web.registerFetchProvider(new TinyfishFetchProvider(tinyfishOptions));
}

export {
    TavilyFetchProvider,
    TavilySearchProvider,
    TAVILY_PROVIDER_ID,
    TinyfishFetchProvider,
    TinyfishSearchProvider,
    TINYFISH_PROVIDER_ID
};
