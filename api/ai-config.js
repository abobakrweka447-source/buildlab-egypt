
'use strict';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'استخدم GET.' });
  }

  const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const supabasePublishableKey = String(
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    ''
  );

  const hasGemini = Boolean(process.env.GEMINI_API_KEY);
  const hasGroq = Boolean(process.env.GROQ_API_KEY);

  const dailyLimit = Math.max(
    1,
    Math.min(50, Number(process.env.AI_DAILY_MESSAGE_LIMIT) || 10)
  );

  const authConfigured = Boolean(supabaseUrl && supabasePublishableKey);

  const aiEnabled =
    String(process.env.AI_CHAT_ENABLED || '').toLowerCase() === 'true' &&
    authConfigured &&
    (hasGemini || hasGroq);

  return res.status(200).json({
    ok: true,
    authConfigured,
    aiEnabled,
    supabaseUrl: authConfigured ? supabaseUrl : null,
    supabasePublishableKey: authConfigured ? supabasePublishableKey : null,
    dailyLimit,
    providerAvailability: {
      gemini: hasGemini,
      groq: hasGroq
    }
  });
};
