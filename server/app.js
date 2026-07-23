const express = require('express');
const path = require('path');
const cors = require('cors');

const { requireApiKey } = require('../middleware/auth');
const Chat = require('../models/Chat');
const Settings = require('../models/Settings');

function createApp() {
  const app = express();
  app.use(cors()); // CORS isn't the security boundary here - the API key is.
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

  app.get('/api/chats', requireApiKey, async (req, res) => {
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

  app.put('/api/chats', requireApiKey, async (req, res) => {
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
  app.post('/api/chats/delete', requireApiKey, async (req, res) => {
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

  app.get('/api/settings', requireApiKey, async (req, res) => {
    try {
      const doc = await Settings.findById('singleton').lean();
      res.json({ settings: doc || { staleDays: 3, closingLabels: [], manualClosing: {} } });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.put('/api/settings', requireApiKey, async (req, res) => {
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
