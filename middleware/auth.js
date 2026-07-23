const jwt = require('jsonwebtoken');

// Two ways to authenticate against the same API:
//  - the extension's background sync sends the static API_KEY directly
//  - the web dashboard sends a JWT issued by POST /api/auth/login after a
//    real user logs in with email/password
// Both arrive as `Authorization: Bearer <token>` - this middleware figures
// out which kind it's looking at.
function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  if (process.env.API_KEY && token === process.env.API_KEY) {
    req.auth = { type: 'extension' };
    return next();
  }

  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ error: 'server misconfigured: JWT_SECRET not set' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.auth = { type: 'user', userId: payload.sub, email: payload.email, role: payload.role };
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'unauthorized' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.auth || req.auth.type !== 'user' || req.auth.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
