// Single shared-secret auth: the extension sends `Authorization: Bearer <key>`,
// checked against the API_KEY env var. This is a personal single-user backend,
// not a multi-tenant API - one static key is enough to keep random internet
// traffic out, but never log or echo the key back in responses.
function requireApiKey(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;

  if (!process.env.API_KEY) {
    return res.status(500).json({ error: 'server misconfigured: API_KEY not set' });
  }
  if (!token || token !== process.env.API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

module.exports = { requireApiKey };
