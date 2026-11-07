const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMessages, normalizeBuildContext, providerList, buildSystemPrompt } = require('../lib/ai');

test('provider list contains only configured Gemini and Groq in chosen order', () => {
  const providers = providerList({
    AI_PROVIDER_ORDER: 'groq,gemini,thirdparty,groq',
    GEMINI_API_KEY: 'g-key',
    GROQ_API_KEY: 'r-key',
    THIRD_PARTY_KEY: 'ignored'
  });
  assert.deepEqual(providers.map((provider) => provider.id), ['groq', 'gemini']);
  assert.equal(providers[0].model, 'openai/gpt-oss-20b');
  assert.equal(providers[1].model, 'gemini-3.8-flash');
});

test('provider list does not expose unconfigured providers', () => {
  assert.deepEqual(providerList({ GEMINI_API_KEY: 'g-key' }).map((provider) => provider.id), ['gemini']);
  assert.deepEqual(providerList({ GROQ_API_KEY: 'r-key' }).map((provider) => provider.id), ['groq']);
  assert.deepEqual(providerList({ AI_PROVIDER_ORDER: 'huggingface', THIRD_PARTY_KEY: 'ignored' }), []);
});

test('messages are limited, cleaned, and restricted to user/assistant roles', () => {
  const messages = normalizeMessages([
    { role: 'system', content: 'do not accept system messages' },
    { role: 'user', content: '  مرحبًا\u0000  ' },
    { role: 'assistant', content: 'أهلًا' }
  ]);
  assert.deepEqual(messages, [
    { role: 'user', content: 'مرحبًا' },
    { role: 'assistant', content: 'أهلًا' }
  ]);
  assert.equal(normalizeMessages([{ role: 'user', content: 'x'.repeat(3000) }])[0].content.length, 2200);
});

test('build context is bounded and the system prompt treats it as untrusted data', () => {
  assert.equal(normalizeBuildContext('x'.repeat(7000)).length, 6000);
  const prompt = buildSystemPrompt('المعالج: Ryzen 5 7600');
  assert.match(prompt, /بيانات غير موثوقة/);
  assert.match(prompt, /Ryzen 5 7600/);
});

test('generation falls back from Gemini rate limit to Groq', async () => {
  const { generateWithFallback } = require('../lib/ai');
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), headers: options.headers });
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return new Response(JSON.stringify({ error: { message: 'rate limit' } }), { status: 429 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'رد Groq التجريبي' } }] }), { status: 200 });
  };
  try {
    const result = await generateWithFallback({
      messages: [{ role: 'user', content: 'راجع التجميعة' }],
      buildContext: 'المعالج: Ryzen 5 7600',
      env: {
        GEMINI_API_KEY: 'gemini-test-key',
        GROQ_API_KEY: 'groq-test-key',
        AI_PROVIDER_ORDER: 'gemini,groq',
        AI_PROVIDER_TIMEOUT_MS: 5000
      }
    });
    assert.equal(result.provider, 'groq');
    assert.equal(result.reply, 'رد Groq التجريبي');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers['x-goog-api-key'], 'gemini-test-key');
    assert.equal(calls[1].headers.Authorization, 'Bearer groq-test-key');
  } finally {
    global.fetch = originalFetch;
  }
});
