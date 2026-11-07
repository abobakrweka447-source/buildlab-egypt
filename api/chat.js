'use strict';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  return res.status(410).json({
    ok: false,
    error: 'هذا المسار قديم. استخدم مساعد BuildLab الجديد.'
  });
};

