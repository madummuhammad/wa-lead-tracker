const express = require('express');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { requireAuth, requireAdmin } = require('../middleware/auth');
const Chat = require('../models/Chat');
const Settings = require('../models/Settings');
const User = require('../models/User');

const TOKEN_EXPIRY = '30d'; // personal tool, favor not re-logging-in over short-lived tokens

function createApp() {
  const app = express();
  app.use(cors()); // CORS isn't the security boundary here - auth is.
  app.use(express.json({ limit: '5mb' }));
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path} auth=${req.get('authorization') ? 'yes' : 'no'}`);
    next();
  });

  // Serves the standalone web dashboard for local dev (`npm run dev` ->
  // http://localhost:3000/). On Netlify, static files under `public/` are
  // served directly by Netlify's CDN per `netlify.toml`'s `publish` setting,
  // so this middleware is simply never reached there - harmless either way.
  app.use(express.static(path.join(__dirname, '../public')));

  app.get('/health', (req, res) => res.json({ ok: true }));

  // ---- Auth ----

  app.post('/api/auth/login', async (req, res) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password) return res.status(400).json({ error: 'email and password required' });
      if (!process.env.JWT_SECRET) return res.status(500).json({ error: 'server misconfigured: JWT_SECRET not set' });

      const user = await User.findOne({ email: String(email).toLowerCase().trim() });
      if (!user) return res.status(401).json({ error: 'invalid credentials' });

      const ok = await bcrypt.compare(password, user.passwordHash);
      if (!ok) return res.status(401).json({ error: 'invalid credentials' });

      const token = jwt.sign(
        { sub: user._id.toString(), email: user.email, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: TOKEN_EXPIRY }
      );
      res.json({ ok: true, token, user: { email: user.email, role: user.role } });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.get('/api/auth/me', requireAuth, (req, res) => {
    if (req.auth.type !== 'user') return res.status(400).json({ error: 'not a user session' });
    res.json({ email: req.auth.email, role: req.auth.role, userId: req.auth.userId });
  });

  // ---- User management (admin only) ----

  app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
    try {
      const users = await User.find({}).select('email role createdAt').lean();
      res.json({ users });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { email, password, role } = req.body || {};
      if (!email || !password) return res.status(400).json({ error: 'email and password required' });
      if (password.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });

      const normalizedEmail = String(email).toLowerCase().trim();
      const existing = await User.findOne({ email: normalizedEmail });
      if (existing) return res.status(409).json({ error: 'email already registered' });

      const passwordHash = await bcrypt.hash(password, 10);
      const user = await User.create({
        email: normalizedEmail,
        passwordHash,
        role: role === 'admin' ? 'admin' : 'user',
      });
      res.json({ ok: true, user: { id: user._id, email: user.email, role: user.role } });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      if (req.params.id === req.auth.userId) {
        return res.status(400).json({ error: "can't delete your own account while logged in as it" });
      }
      await User.findByIdAndDelete(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ---- Chats ----

  app.get('/api/chats', requireAuth, async (req, res) => {
    try {
      const docs = await Chat.find({}).lean();
      const chats = {};
      docs.forEach((doc) => {
        const { _id, __v, createdAt, ...rest } = doc;
        chats[_id] = { id: _id, ...rest };
      });
      res.json({ chats });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.put('/api/chats', requireAuth, async (req, res) => {
    try {
      const chats = req.body;
      if (!chats || typeof chats !== 'object' || Array.isArray(chats)) {
        return res.status(400).json({ error: 'body must be an object keyed by chat id' });
      }

      const ops = Object.entries(chats).map(([id, data]) => ({
        updateOne: {
          filter: { _id: id },
          update: { $set: { ...data, _id: id } },
          upsert: true,
        },
      }));

      if (ops.length > 0) await Chat.bulkWrite(ops);
      res.json({ ok: true, count: ops.length });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Bulk delete - the extension deletes locally then re-pushes the whole
  // remaining `chats` object, but a client with no local mirror (the web
  // dashboard) needs to tell the server directly which ids to remove.
  app.post('/api/chats/delete', requireAuth, async (req, res) => {
    try {
      const { ids } = req.body || {};
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'body must be { ids: [...] }' });
      }
      const result = await Chat.deleteMany({ _id: { $in: ids } });
      res.json({ ok: true, deletedCount: result.deletedCount });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.get('/api/settings', requireAuth, async (req, res) => {
    try {
      const doc = await Settings.findById('singleton').lean();
      res.json({ settings: doc || { staleDays: 3, closingLabels: [], manualClosing: {} } });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.put('/api/settings', requireAuth, async (req, res) => {
    try {
      const data = req.body || {};
      const doc = await Settings.findByIdAndUpdate(
        'singleton',
        { $set: data },
        { upsert: true, new: true }
      ).lean();
      res.json({ ok: true, settings: doc });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  return app;
}

module.exports = { createApp };
