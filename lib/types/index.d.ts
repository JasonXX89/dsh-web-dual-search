/**
 * Public types for the dual-backend web provider plugin.
 *
 * @module dsh-web-dual-search
 */
import type { Context } from '@deepseek-ai/cordis';
import type { WebFetchProvider, WebSearchProvider } from '@deepseek-ai/dsh-web';

export declare const name: 'dsh-web-dual-search';
export declare const inject: readonly ['web'];

/** Stable id the Tavily providers register under. */
export declare const TAVILY_PROVIDER_ID: 'tavily';
/** Stable id the TinyFish providers register under. */
export declare const TINYFISH_PROVIDER_ID: 'tinyfish';

/** Default Tavily API base. */
export declare const TAVILY_DEFAULT_BASE_URL: string;
/** Default TinyFish search base. */
export declare const TINYFISH_DEFAULT_SEARCH_BASE: string;
/** Default TinyFish fetch base. */
export declare const TINYFISH_DEFAULT_FETCH_BASE: string;

/** The plugin's configuration schema. */
export declare const Config: any;

/**
 * Register both backends' providers with the web seam.
 * @param ctx - the plugin context.
 * @param config - the plugin's resolved configuration.
 */
export declare function apply(ctx: Context, config: any): void;

/** The Tavily search provider. */
export declare class TavilySearchProvider implements WebSearchProvider {
    readonly id: 'tavily';
    constructor(resolveOptions: () => any);
    available(): boolean;
    ready(): Promise<boolean>;
    search(request: any, signal?: AbortSignal): Promise<any>;
}

/** The Tavily fetch provider. */
export declare class TavilyFetchProvider implements WebFetchProvider {
    readonly id: 'tavily';
    constructor(resolveOptions: () => any);
    available(): boolean;
    ready(): Promise<boolean>;
    fetch(request: any, signal?: AbortSignal): Promise<any>;
}

/** The TinyFish search provider. */
export declare class TinyfishSearchProvider implements WebSearchProvider {
    readonly id: 'tinyfish';
    constructor(resolveOptions: () => any);
    available(): boolean;
    ready(): Promise<boolean>;
    search(request: any, signal?: AbortSignal): Promise<any>;
}

/** The TinyFish fetch provider. */
export declare class TinyfishFetchProvider implements WebFetchProvider {
    readonly id: 'tinyfish';
    constructor(resolveOptions: () => any);
    available(): boolean;
    ready(): Promise<boolean>;
    fetch(request: any, signal?: AbortSignal): Promise<any>;
}
