'use strict';

const MAX_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 4000;
const MAX_CONTEXT_CHARS = 7000;

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalizeMessages(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(-MAX_MESSAGES).map((item) => ({
    role: item?.role === 'assistant' ? 'assistant' : 'user',
    content: cleanText(item?.content, MAX_MESSAGE_CHARS)
  })).filter((item) => item.content);
}

function buildSystemPrompt(buildContext) {
  return [
    'أنت BuildLab AI، مستشار تقني داخل موقع مصري لبناء ومقارنة تجميعات الكمبيوتر.',
    'مهمتك مراجعة توافق القطع، كشف التعارضات والاختناقات المحتملة، وشرح المفاضلات واقتراح بدائل قريبة في السعر عند توفر معلومات كافية.',
    'لا تخترع أسعارًا أو توافرًا أو مواصفات. إذا لم تتوفر بيانات حديثة، اطلب من المستخدم التحقق من المتجر أو تزويدك بالرابط.',
    'فرّق بين عدم التوافق المؤكد وبين مجرد احتمال وجود اختناق يعتمد على الدقة واللعبة والإعدادات.',
    'أجب بالعربية المصرية الواضحة، وكن مباشرًا. لا تدّع أنك غيّرت التجميعة؛ أنت مستشار فقط.',
    buildContext ? `\nسياق التجميعة الحالية (بيانات من المتصفح وقد تكون غير مكتملة):\n${buildContext}` : '\nلم يرسل الموقع تجميعة حالية.'
  ].join('\n');
}

async function callGemini(messages, systemPrompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY غير مضبوط');
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { temperature: 0.35, maxOutputTokens: 900 }
    }),
    signal: AbortSignal.timeout(25000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error?.message || `Gemini HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('Gemini رجّع ردًا فارغًا');
  return text;
}

async function callOpenAICompatible({ provider, baseUrl, key, model, messages, systemPrompt }) {
  if (!key) throw new Error(`${provider} غير مضبوط`);

  // GPT-OSS on Groq returns reasoning separately by default. Disable that field
  // and reserve a proper completion-token budget for the final user-facing text.
  const isGptOss = provider === 'Groq' && model.startsWith('openai/gpt-oss-');
  const requestMessages = isGptOss
    ? [{
        role: 'user',
        content: `تعليمات المساعد:\n${systemPrompt}\n\nاتبع التعليمات السابقة وأجب عن آخر رسالة مستخدم في المحادثة التالية.`
      }, ...messages]
    : [{ role: 'system', content: systemPrompt }, ...messages];

  const requestBody = {
    model,
    messages: requestMessages,
    temperature: 0.35
  };

  if (isGptOss) {
    requestBody.max_completion_tokens = 1400;
    requestBody.include_reasoning = false;
    requestBody.reasoning_effort = 'low';
  } else {
    requestBody.max_tokens = 900;
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(25000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error?.message || `${provider} HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) {
    const finishReason = data?.choices?.[0]?.finish_reason || 'unknown';
    throw new Error(`${provider} رجّع ردًا فارغًا (finish_reason=${finishReason})`);
  }
  return text;
}

const PROVIDERS = {
  gemini: (messages, systemPrompt) => callGemini(messages, systemPrompt),
  groq: (messages, systemPrompt) => callOpenAICompatible({
    provider: 'Groq', baseUrl: 'https://api.groq.com/openai/v1',
    key: process.env.GROQ_API_KEY, model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    messages, systemPrompt
  }),
  huggingface: (messages, systemPrompt) => callOpenAICompatible({
    provider: 'Hugging Face', baseUrl: 'https://router.huggingface.co/v1',
    key: process.env.HF_TOKEN, model: process.env.HF_MODEL || 'meta-llama/Llama-3.1-8B-Instruct',
    messages, systemPrompt
  })
};

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Vary', 'Origin');
  if (req.method !== 'POST') return res.status(405).json({ error: 'استخدم POST.' });
  if (process.env.AI_CHAT_ENABLED !== 'true') {
    return res.status(503).json({ error: 'مساعد BuildLab غير مفعّل حاليًا. اضبط AI_CHAT_ENABLED بعد إعداد المفتاح.' });
  }

  const messages = normalizeMessages(req.body?.messages);
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'ابعت رسالة مستخدم صالحة.' });
  }
  const buildContext = cleanText(req.body?.buildContext, MAX_CONTEXT_CHARS);
  const systemPrompt = buildSystemPrompt(buildContext);
  const order = (process.env.AI_PROVIDER_ORDER || 'gemini,groq,huggingface')
    .split(',').map((x) => x.trim().toLowerCase()).filter((x, i, a) => PROVIDERS[x] && a.indexOf(x) === i);
  const errors = [];

  for (const name of order) {
    const configured = name === 'gemini' ? !!process.env.GEMINI_API_KEY
      : name === 'groq' ? !!process.env.GROQ_API_KEY : !!process.env.HF_TOKEN;
    if (!configured) continue;
    try {
      const answer = await PROVIDERS[name](messages, systemPrompt);
      return res.status(200).json({ ok: true, answer, provider: name });
    } catch (error) {
      errors.push(`${name}: ${String(error.message || error).slice(0, 180)}`);
      // Try the next configured provider when a provider is unavailable.
    }
  }

  console.error('[BuildLab AI] All configured providers failed:', errors);
  return res.status(503).json({ error: 'كل مزودي الذكاء الاصطناعي المتاحين فشلوا أو وصلوا لحد الاستخدام. جرّب لاحقًا.' });
};
