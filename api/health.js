'use strict';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ ok: false, error: 'استخدم GET.' });
  }
  return res.status(200).json({
    ok: true,
    app: 'BuildLab مصر',
    version: '2.1.1',
    service: 'website-api',
    checkedAt: new Date().toISOString()
  });
};
