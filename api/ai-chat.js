'use strict';

const { normalizeMessages, normalizeBuildContext, providerList, generateWithFallback } = require('../lib/ai');

function bearerToken(req) {
  const header = String(req.headers?.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function supabaseRpc(name, body) {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!url || !key) throw new Error('إعدادات Supabase الخاصة بالحصص غير مكتملة.');
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(String(data?.message || data?.hint || `Supabase HTTP ${response.status}`).slice(0, 220));
    error.status = response.status;
    throw error;
  }
  return data;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Vary', 'Authorization');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'استخدم POST.' });

  if (String(process.env.AI_CHAT_ENABLED || '').toLowerCase() !== 'true') {
    return res.status(503).json({ ok: false, error: 'مستشار BuildLab غير مفعّل على الاستضافة بعد.' });
  }

  const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const publishableKey = String(process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '');
  const secretKey = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!supabaseUrl || !publishableKey || !secretKey || !providerList().length) {
    return res.status(503).json({ ok: false, error: 'إعدادات تسجيل الدخول أو مفاتيح Gemini وGroq غير مكتملة.' });
  }

  const contentLength = Number(req.headers?.['content-length'] || 0);
  if (contentLength > 40000) return res.status(413).json({ ok: false, error: 'حجم الرسالة وسياق التجميعة أكبر من الحد المسموح.' });

  const token = bearerToken(req);
  if (!token || token.length > 10000) return res.status(401).json({ ok: false, error: 'سجّل الدخول لاستخدام مستشار BuildLab.' });

  let user;
  try {
    const authResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: publishableKey, Authorization: `Bearer ${token}` }
    });
    if (!authResponse.ok) return res.status(401).json({ ok: false, error: 'جلسة تسجيل الدخول غير صالحة. سجّل الدخول مرة أخرى.' });
    user = await authResponse.json();
  } catch {
    return res.status(503).json({ ok: false, error: 'تعذر التحقق من تسجيل الدخول مؤقتًا.' });
  }
  if (!user?.id) return res.status(401).json({ ok: false, error: 'تعذر تحديد الحساب المسجل.' });

  const messages = normalizeMessages(req.body?.messages);
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return res.status(400).json({ ok: false, error: 'اكتب رسالة صحيحة قبل الإرسال.' });
  }
  const buildContext = normalizeBuildContext(req.body?.buildContext);
  const dailyLimit = Math.max(1, Math.min(50, Number(process.env.AI_DAILY_MESSAGE_LIMIT) || 10));

  let quota;
  try {
    quota = await supabaseRpc('consume_buildlab_ai_quota', {
      p_user_id: user.id,
      p_daily_limit: dailyLimit
    });
  } catch (error) {
    console.error('[BuildLab AI] Quota reservation failed:', error.status || '', error.message);
    return res.status(503).json({ ok: false, error: 'نظام الحصص لم يُجهّز بعد. شغّل ملف SQL المرفق في Supabase.' });
  }

  if (!quota?.allowed) {
    return res.status(429).json({
      ok: false,
      error: 'وصلت للحد اليومي لرسائل مستشار BuildLab. حصتك هتتجدد مع بداية اليوم الجديد بتوقيت القاهرة.',
      usage: { used: quota?.used ?? dailyLimit, limit: dailyLimit, remaining: 0, resetAt: quota?.reset_at || null }
    });
  }

  try {
    const result = await generateWithFallback({ messages, buildContext });
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
      await supabaseRpc('refund_buildlab_ai_quota', { p_user_id: user.id });
    } catch (refundError) {
      console.error('[BuildLab AI] Quota refund failed:', refundError?.status || '', refundError?.message || 'unknown');
    }
    console.error('[BuildLab AI] Both providers failed:', (error.providerErrors || []).map((item) => `${item.provider}:${item.status}`).join(', '));
    return res.status(error.status || 503).json({ ok: false, error: error.message || 'تعذر الحصول على رد من مستشار BuildLab.' });
  }
};
