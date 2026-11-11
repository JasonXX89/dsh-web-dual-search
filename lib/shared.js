/**
 * Shared plumbing for the Tavily and TinyFish web providers: credential
 * lookup, HTTP dispatch, retry, and the small value coercions both backends
 * need to speak the seam's vocabulary.
 *
 * @module dsh-web-dual-search/shared
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { WebError } from '@deepseek-ai/dsh-web';

/** Error code for a provider failure that is not the caller's fault. */
export const WEB_PROVIDER_ERROR = 'WEB_PROVIDER_ERROR';
/** Error code for a missing credential. */
export const WEB_PROVIDER_CREDENTIAL_MISSING = 'WEB_PROVIDER_CREDENTIAL_MISSING';
/** Error code for a cancelled request. */
export const WEB_ABORTED = 'WEB_ABORTED';

/** User agent sent on every outbound request. */
export const USER_AGENT = 'deepseek-harness-dsh-web-dual-search/0.1.0';

/**
 * A provider failure that a later attempt may well not repeat.
 *
 * The seam owns no retry policy, so the provider decides: 429 and 5xx are
 * transient, a 4xx is a configuration or request mistake and is not.
 */
export class TransientWebError extends WebError {
    constructor(message, code, options) {
        super(message, code, options);
        this.name = 'TransientWebError';
    }
}

/** Whether a thrown value is a transient provider failure. */
export function isTransient(error) {
    return error instanceof TransientWebError;
}

/** Narrow an untrusted value to a plain object. */
export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The provider's stable cancellation error, keeping the caller's reason.
 * @param signal - the caller's cancellation signal.
 * @param cause - the underlying failure, when there is one.
 * @returns the cancellation error.
 */
export function aborted(signal, cause) {
    const reason = signal?.aborted === true ? signal.reason : undefined;
    return new WebError('Web request aborted', WEB_ABORTED, reason === undefined ? { cause } : { cause: reason });
}

/** Whether an error is a fetch / AbortSignal abort. */
export function isAbortError(error) {
    return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * A date as an ISO-8601 string, or undefined when it cannot be read.
 *
 * Tavily reports published_date in RFC-1123 form ("Tue, 10 Nov 2026 11:00:00
 * GMT"); TinyFish reports human strings ("Apr 30, 2026"). The seam's
 * publishedAt is contractually ISO-8601, so what parses is coerced and what
 * does not is dropped: a missing date is honest, a malformed one is not.
 *
 * A date carrying no timezone is read as UTC rather than local. Date.parse
 * reads "Apr 30, 2026" as local midnight, so toISOString would shift the day
 * for every host east or west of Greenwich — the same page would report a
 * different publishedAt depending on where the process ran.
 *
 * @param value - the provider's date string.
 * @returns the ISO form, or undefined.
 */
export function toIsoDate(value) {
    if (typeof value !== 'string' || value.trim().length === 0) return undefined;
    const text = value.trim();
    const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/iu.test(text);
    let candidate = text;
    if (!zoned) {
        if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) candidate = text + 'T00:00:00Z';
        else if (/^\d{4}-\d{2}-\d{2}[T ]/u.test(text)) candidate = text.replace(' ', 'T') + 'Z';
        else candidate = text + ' UTC';
    }
    const parsed = Date.parse(candidate);
    if (Number.isNaN(parsed)) return undefined;
    return new Date(parsed).toISOString();
}

/**
 * The absolute http(s) form of a URL, normalized — or undefined.
 *
 * The URL that ships to the model is the one this function read. Reporting the
 * raw string instead would hand back something like "  https://a.example/p  ",
 * which parses to the same destination but is not what was checked.
 *
 * @param value - the provider's URL string.
 * @returns the normalized href, or undefined when it is not http(s).
 */
export function absoluteHttpUrl(value) {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    const parsed = URL.parse(value.trim());
    if (parsed === null) return undefined;
    const { protocol } = parsed;
    return protocol === 'http:' || protocol === 'https:' ? parsed.href : undefined;
}

/**
 * Bound a string to a character count, never splitting a surrogate pair.
 *
 * @param value - the text.
 * @param limit - the maximum number of characters.
 * @returns the bounded text, or undefined when there is none.
 */
export function boundText(value, limit) {
    if (typeof value !== 'string') return undefined;
    const text = value.replace(/\s+/gu, ' ').trim();
    if (text.length === 0) return undefined;
    if (text.length <= limit) return text;
    return Array.from(text).slice(0, limit).join('') + '…';
}

/**
 * One fetch with the provider's auth applied, failures mapped to WebError.
 *
 * @param url - the endpoint.
 * @param options - auth headers, method, body, and the caller's signal.
 * @returns the decoded JSON body.
 */
export async function callApi(url, options) {
    const { headers, method, body, signal } = options;
    let response;
    try {
        response = await fetch(url, {
            method,
            headers: {
                'User-Agent': USER_AGENT,
                ...headers,
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                Accept: 'application/json'
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            redirect: 'error',
            ...(signal === undefined ? {} : { signal })
        });
    } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error);
        throw new WebError('Web request to ' + url + ' failed: ' + String(error), WEB_PROVIDER_ERROR, { cause: error });
    }
    if (response.status === 401 || response.status === 403) {
        throw new WebError(
            'The web provider rejected the API key (HTTP ' + response.status + '). Refresh it, or switch the web provider.',
            WEB_PROVIDER_ERROR
        );
    }
    if (response.status === 429) throw new TransientWebError('The web provider rate limit was reached (HTTP 429).', WEB_PROVIDER_ERROR);
    if (response.status >= 500) throw new TransientWebError('The web provider returned HTTP ' + response.status + ' for ' + url, WEB_PROVIDER_ERROR);
    if (!response.ok) {
        let detail = '';
        try {
            const parsed = await response.json();
            if (isRecord(parsed)) {
                const message = typeof parsed.error === 'string'
                    ? parsed.error
                    : (isRecord(parsed.error) ? parsed.error.message : parsed.message);
                if (typeof message === 'string') detail = ': ' + message;
            }
        } catch {
            // A non-JSON error body carries no structured detail worth reporting.
        }
        throw new WebError('The web provider returned HTTP ' + response.status + ' for ' + url + detail, WEB_PROVIDER_ERROR);
    }
    try {
        return await response.json();
    } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error);
        throw new WebError('The web provider returned a non-JSON body for ' + url, WEB_PROVIDER_ERROR, { cause: error });
    }
}

/**
 * Sleep, honoring cancellation.
 * @param ms - milliseconds to wait.
 * @param signal - the caller's cancellation signal.
 * @returns a promise resolved after the delay.
 */
export function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted === true) {
            reject(aborted(signal));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(aborted(signal));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Run one operation with a bounded retry for transient failures.
 *
 * @param operation - the attempt.
 * @param options - attempt count, delay, cancellation, and the retry predicate.
 * @returns the operation's value.
 */
export async function withRetry(operation, options) {
    const { attempts, delayMs, signal, retryWhen } = options;
    const limit = Math.max(1, attempts);
    let lastError;
    for (let attempt = 1; attempt <= limit; attempt++) {
        if (signal?.aborted === true) throw aborted(signal);
        try {
            const value = await operation();
            if (attempt === limit || retryWhen === undefined || !retryWhen(value)) return value;
            lastError = undefined;
        } catch (error) {
            if (signal?.aborted === true) throw aborted(signal, error);
            if (!isTransient(error)) throw error;
            lastError = error;
            if (attempt === limit) throw error;
        }
        if (delayMs > 0) await sleep(delayMs, signal);
    }
    throw lastError ?? new WebError('The web provider request failed.', WEB_PROVIDER_ERROR);
}

/**
 * Read a JSON credential file, tolerating any absence.
 *
 * @param path - the file to read.
 * @param field - the field holding the key.
 * @returns the key, or an empty string.
 */
export function readKeyFile(path, field) {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (!isRecord(parsed)) return '';
        const value = parsed[field];
        return typeof value === 'string' ? value.trim() : '';
    } catch {
        return '';
    }
}

/**
 * Build the credential resolver for one backend.
 *
 * The harness credentials service is consulted first when it is present, then
 * the provider's own local store, then the launch environment. The service
 * comes before the environment because it is where the settings page saves a
 * key: a key saved there must win over an inherited shell variable, or the
 * operator's own save would appear to have no effect.
 *
 * @param ctx - the plugin context.
 * @param options - the literal key, the credential ref, and the local files.
 * @returns an async resolver.
 */
export function credentialResolver(ctx, options) {
    const { literal, ref, files } = options;
    const credentials = ctx.get('credentials');
    const environment = launchEnvironmentOf(ctx);
    return async () => {
        if (typeof literal === 'string' && literal.trim().length > 0) return literal.trim();
        if (credentials !== undefined && typeof ref === 'string' && ref.length > 0) {
            const resolved = await credentials.resolve(credentialRef(ref));
            if (typeof resolved?.value === 'string' && resolved.value.trim().length > 0) return resolved.value.trim();
        }
        for (const file of files) {
            const value = readKeyFile(file.path, file.field);
            if (value.length > 0) return value;
        }
        for (const name of [ref, ...files.map(file => file.envName)].filter(name => typeof name === 'string')) {
            const entry = environment.get(name);
            if (entry !== undefined && entry.value.trim().length > 0) return entry.value.trim();
        }
        return undefined;
    };
}

/**
 * The synchronous availability probe for one backend.
 *
 * available() must answer without awaiting, so it cannot consult the
 * credentials service. A service-backed credential is reported as "possibly
 * present" rather than as absent — reporting a Settings-saved key as missing
 * would make the seam refuse a provider that can actually authenticate.
 *
 * @param ctx - the plugin context.
 * @param options - the literal key, the environment names, and the local files.
 * @returns whether a credential is reachable without the credentials service.
 */
export function credentialAvailable(ctx, options) {
    const { literal, envNames, files } = options;
    if (typeof literal === 'string' && literal.trim().length > 0) return true;
    const environment = launchEnvironmentOf(ctx);
    for (const name of envNames) {
        const entry = environment.get(name);
        if (entry !== undefined && entry.value.trim().length > 0) return true;
    }
    for (const file of files) {
        if (readKeyFile(file.path, file.field).length > 0) return true;
    }
    return ctx.get('credentials') !== undefined;
}

/**
 * The missing-credential error, naming every place a key may live.
 * @param backend - the backend's display name.
 * @param hint - the backend-specific storage hints.
 * @returns the error.
 */
export function missingCredential(backend, hint) {
    return new WebError('The ' + backend + ' web provider has no API key. ' + hint, WEB_PROVIDER_CREDENTIAL_MISSING);
}

/**
 * The default home of a provider's own credential file.
 * @param name - the provider's directory name.
 * @param file - the file name.
 * @returns the absolute path.
 */
export function providerConfigPath(name, file) {
    return join(homedir(), '.' + name, file);
}
