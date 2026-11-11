/**
 * Live-ish unit checks for the dual-backend web providers.
 *
 * Every HTTP call is served by a stub `fetch`, so the suite asserts the
 * request each backend makes and the mapping each one performs — the two
 * places where an adapter silently goes wrong.
 */
import assert from 'node:assert/strict';
import { TavilyFetchProvider, TavilySearchProvider } from '../lib/tavily.js';
import { TinyfishFetchProvider, TinyfishSearchProvider } from '../lib/tinyfish.js';
import { toIsoDate } from '../lib/shared.js';

const realFetch = globalThis.fetch;

/** Install a fetch stub and return a restore function. */
function stubFetch(handler) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        const response = handler(String(url), init);
        return new Response(response.body, {
            status: response.status ?? 200,
            headers: { 'Content-Type': 'application/json' }
        });
    };
    return {
        calls,
        restore() {
            globalThis.fetch = realFetch;
        }
    };
}

/** A provider-options object with the credential already resolved. */
function options(overrides = {}) {
    return {
        baseURL: 'https://api.tavily.com',
        resolveCredential: async () => 'test-key',
        credentialAvailable: true,
        count: 10,
        includeAnswer: true,
        includeRawContent: false,
        topic: 'general',
        depth: 'basic',
        domains: [],
        snippetMaxChars: 400,
        summaryMaxChars: 2000,
        bodyMaxChars: 50000,
        attempts: 1,
        retryDelayMs: 0,
        ...overrides
    };
}

const results = [];
async function test(name, fn) {
    try {
        await fn();
        results.push({ name, ok: true });
        console.log('  ✓ ' + name);
    } catch (error) {
        results.push({ name, ok: false, error });
        console.log('  ✗ ' + name + ' — ' + error.message);
    }
}

console.log('Tavily');

await test('search maps content to snippet and answers to content', async () => {
    const stub = stubFetch(() => ({
        body: JSON.stringify({
            answer: 'A short answer.',
            results: [
                {
                    url: 'https://example.com/a',
                    title: 'Page A',
                    content: 'Short excerpt.',
                    published_date: 'Tue, 10 Nov 2026 11:00:00 GMT'
                }
            ]
        })
    }));
    try {
        const provider = new TavilySearchProvider(() => options());
        const result = await provider.search({ query: 'q', maxResults: 5 });
        assert.equal(result.content, 'A short answer.');
        assert.equal(result.sources.length, 1);
        assert.equal(result.sources[0].snippet, 'Short excerpt.');
        assert.equal(result.sources[0].title, 'Page A');
        assert.equal(result.sources[0].publishedAt, '2026-11-10T11:00:00.000Z');
        assert.equal(stub.calls[0].url, 'https://api.tavily.com/search');
        assert.equal(stub.calls[0].init.method, 'POST');
        assert.equal(stub.calls[0].init.headers.authorization, 'Bearer test-key');
        const body = JSON.parse(stub.calls[0].init.body);
        assert.equal(body.query, 'q');
        assert.equal(body.max_results, 5);
        assert.equal(body.include_answer, true);
    } finally {
        stub.restore();
    }
});

await test('search maps raw_content to summary when requested', async () => {
    const stub = stubFetch(() => ({
        body: JSON.stringify({
            results: [{ url: 'https://example.com/a', content: 'x', raw_content: 'Full page text here.' }]
        })
    }));
    try {
        const provider = new TavilySearchProvider(() => options({ includeRawContent: true }));
        const result = await provider.search({ query: 'q', maxResults: 5 });
        assert.equal(result.sources[0].summary, 'Full page text here.');
        assert.equal(JSON.parse(stub.calls[0].init.body).include_raw_content, true);
    } finally {
        stub.restore();
    }
});

await test('search drops a row whose URL is not http(s)', async () => {
    const stub = stubFetch(() => ({
        body: JSON.stringify({
            results: [
                { url: 'javascript:alert(1)', title: 'bad', content: 'x' },
                { url: 'https://example.com/ok', title: 'good', content: 'y' }
            ]
        })
    }));
    try {
        const provider = new TavilySearchProvider(() => options());
        const result = await provider.search({ query: 'q', maxResults: 5 });
        assert.equal(result.sources.length, 1);
        assert.equal(result.sources[0].url, 'https://example.com/ok');
    } finally {
        stub.restore();
    }
});

await test('fetch uses /extract and returns raw_content', async () => {
    const stub = stubFetch(() => ({
        body: JSON.stringify({
            results: [{ url: 'https://example.com/p', title: 'P', raw_content: 'Page body.' }],
            failed_results: []
        })
    }));
    try {
        const provider = new TavilyFetchProvider(() => options());
        const result = await provider.fetch({ url: 'https://example.com/p' });
        assert.equal(result.statusCode, 200);
        assert.equal(result.body.content, 'Page body.');
        assert.equal(result.url, 'https://example.com/p');
        assert.equal(stub.calls[0].url, 'https://api.tavily.com/extract');
        assert.deepEqual(JSON.parse(stub.calls[0].init.body).urls, ['https://example.com/p']);
    } finally {
        stub.restore();
    }
});

await test('fetch reports a failed page as a result, not a throw', async () => {
    const stub = stubFetch(() => ({
        body: JSON.stringify({
            results: [],
            failed_results: [{ url: 'https://example.com/p', error: 'Failed to fetch url' }]
        })
    }));
    try {
        const provider = new TavilyFetchProvider(() => options());
        const result = await provider.fetch({ url: 'https://example.com/p' });
        assert.equal(result.statusCode, 502);
        assert.match(result.body.content, /Failed to fetch url/);
    } finally {
        stub.restore();
    }
});

await test('a rejected key raises the credential-missing error', async () => {
    const provider = new TavilySearchProvider(() => options({ resolveCredential: async () => undefined }));
    await assert.rejects(
        () => provider.search({ query: 'q', maxResults: 5 }),
        error => error.code === 'WEB_PROVIDER_CREDENTIAL_MISSING'
    );
});

console.log('TinyFish');

const tinyfishOptions = (overrides = {}) => options({
    searchBase: 'https://api.search.tinyfish.ai',
    fetchBase: 'https://api.fetch.tinyfish.ai',
    maxResults: 10,
    ...overrides
});

await test('search sends the query in the query string with X-API-Key', async () => {
    const stub = stubFetch(() => ({
        body: JSON.stringify({
            results: [
                {
                    position: 1,
                    site_name: 'Example',
                    title: 'Hit One',
                    snippet: 'A snippet.',
                    description: 'A longer description.',
                    url: 'https://example.com/1',
                    date: 'Apr 30, 2026'
                }
            ]
        })
    }));
    try {
        const provider = new TinyfishSearchProvider(() => tinyfishOptions());
        const result = await provider.search({ query: 'deepseek harness', maxResults: 5 });
        assert.equal(result.sources[0].snippet, 'A snippet.');
        assert.equal(result.sources[0].summary, 'A longer description.');
        assert.equal(result.sources[0].publishedAt, '2026-04-30T00:00:00.000Z');
        assert.match(stub.calls[0].url, /^https:\/\/api\.search\.tinyfish\.ai\?/);
        assert.match(stub.calls[0].url, /query=deepseek\+harness/);
        assert.equal(stub.calls[0].init.headers['X-API-Key'], 'test-key');
        assert.equal(stub.calls[0].init.method, 'GET');
    } finally {
        stub.restore();
    }
});

await test('search retries an empty result set once', async () => {
    let count = 0;
    const stub = stubFetch(() => {
        count += 1;
        return {
            body: JSON.stringify(
                count === 1
                    ? { results: [] }
                    : { results: [{ url: 'https://example.com/1', title: 'T', snippet: 'S' }] }
            )
        };
    });
    try {
        const provider = new TinyfishSearchProvider(() => tinyfishOptions({ attempts: 2 }));
        const result = await provider.search({ query: 'q', maxResults: 5 });
        assert.equal(count, 2);
        assert.equal(result.sources.length, 1);
    } finally {
        stub.restore();
    }
});

await test('fetch posts urls and format to the fetch host', async () => {
    const stub = stubFetch(() => ({
        body: JSON.stringify({
            results: [{ url: 'https://example.com/p', final_url: 'https://example.com/p', text: 'Body text.' }],
            errors: []
        })
    }));
    try {
        const provider = new TinyfishFetchProvider(() => tinyfishOptions());
        const result = await provider.fetch({ url: 'https://example.com/p' });
        assert.equal(result.body.content, 'Body text.');
        assert.equal(stub.calls[0].url, 'https://api.fetch.tinyfish.ai');
        const body = JSON.parse(stub.calls[0].init.body);
        assert.deepEqual(body.urls, ['https://example.com/p']);
        assert.equal(body.format, 'markdown');
    } finally {
        stub.restore();
    }
});

console.log('Dates');

await test('a date-only string is read as UTC, not local midnight', () => {
    assert.equal(toIsoDate('2026-04-30'), '2026-04-30T00:00:00.000Z');
});

await test('an unparseable date is dropped rather than guessed', () => {
    assert.equal(toIsoDate('not a date'), undefined);
    assert.equal(toIsoDate(''), undefined);
    assert.equal(toIsoDate(undefined), undefined);
});

const failed = results.filter(r => !r.ok);
console.log('');
console.log(results.length - failed.length + '/' + results.length + ' passed');
if (failed.length > 0) {
    for (const failure of failed) console.error(failure.name + ': ' + failure.error.stack);
    process.exit(1);
}
