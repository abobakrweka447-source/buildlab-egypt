'use strict';

const {
  normalizeMessages,
  normalizeBuildContext,
  providerList,
  generateWithFallback
} = require('../lib/ai');

function getToken(req) {
  const header = String(req.headers?.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function supabaseRpc(url, key, token, name, body) {
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error('تعذر تنفيذ عملية الحصة في Supabase.');
    error.status = response.status;
    throw error;
  }

  return data;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Vary', 'Authorization');

  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'استخدم POST.'
    });
  }

  if (String(process.env.AI_CHAT_ENABLED).toLowerCase() !== 'true') {
    return res.status(503).json({
      ok: false,
      error: 'مستشار BuildLab غير مفعّل حاليًا.'
    });
  }

  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    ''
  );

  const token = getToken(req);

  if (!url || !key || !token || token.length > 10000) {
    return res.status(401).json({
      ok: false,
      error: 'سجّل الدخول لاستخدام المستشار.'
    });
  }

  if (Number(req.headers?.['content-length'] || 0) > 40000) {
    return res.status(413).json({
      ok: false,
      error: 'حجم الطلب أكبر من الحد المسموح.'
    });
  }

  let user;

  try {
    const auth = await fetch(`${url}/auth/v1/user`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${token}`
      }
    });

    if (!auth.ok) {
      return res.status(401).json({
        ok: false,
        error: 'جلسة الدخول غير صالحة. سجّل الدخول مرة أخرى.'
      });
    }

    user = await auth.json();
  } catch {
    return res.status(503).json({
      ok: false,
      error: 'تعذر التحقق من الحساب مؤقتًا.'
    });
  }

  if (!user?.id) {
    return res.status(401).json({
      ok: false,
      error: 'تعذر تحديد الحساب.'
    });
  }

  const messages = normalizeMessages(req.body?.messages);

  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return res.status(400).json({
      ok: false,
      error: 'اكتب رسالة صحيحة قبل الإرسال.'
    });
  }

  const buildContext = normalizeBuildContext(req.body?.buildContext);
  const providers = providerList();

  if (!providers.length) {
    return res.status(503).json({
      ok: false,
      error: 'مفاتيح Gemini وGroq غير مضبوطة.'
    });
  }

  const dailyLimit = Math.max(
    1,
    Math.min(50, Number(process.env.AI_DAILY_MESSAGE_LIMIT) || 10)
  );

  let quota;

  try {
    quota = await supabaseRpc(
      url,
      key,
      token,
      'consume_ai_daily_quota',
      {
        p_user_id: user.id,
        p_provider: 'gemini',
        p_daily_limit: dailyLimit
      }
    );
  } catch (error) {
    console.error('[BuildLab quota]', error.status || '', error.message);

    return res.status(503).json({
      ok: false,
      error: 'تعذر حجز حصتك اليومية. حاول لاحقًا.'
    });
  }

  if (!quota?.allowed) {
    return res.status(429).json({
      ok: false,
      error: 'وصلت للحد اليومي لرسائل مستشار BuildLab. حصتك تتجدد مع بداية اليوم الجديد بتوقيت القاهرة.',
      usage: {
        used: quota.used,
        limit: quota.limit,
        remaining: 0,
        resetAt: quota.reset_at || null
      }
    });
  }

  try {
    const result = await generateWithFallback({
      messages,
      buildContext
    });

    return res.status(200).json({
      ok: true,
      reply: result.reply,
      provider: result.provider,
      model: result.model,
      usage: {
        used: quota.used,
        limit: dailyLimit,
        remaining: quota.remaining,
        resetAt: quota.reset_at || null
      }
    });
  } catch (error) {
    try {
      await supabaseRpc(
        url,
        key,
        token,
        'refund_ai_daily_quota',
        {
          p_user_id: user.id,
          p_provider: 'gemini',
          p_usage_date: quota.usage_date
        }
      );
    } catch (refundError) {
      console.error('[BuildLab refund]', refundError.message);
    }

    console.error('[BuildLab AI failed]', error.providerErrors || error.message);

    return res.status(503).json({
      ok: false,
      error: 'مزودو الذكاء الاصطناعي غير متاحين حاليًا.'
    });
  }
};
