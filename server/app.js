const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const ExcelJS = require('exceljs');

const { requireAuth, requireAdmin } = require('../middleware/auth');
const Chat = require('../models/Chat');
const Settings = require('../models/Settings');
const User = require('../models/User');
const Product = require('../models/Product');
const Order = require('../models/Order');
const PreOrder = require('../models/PreOrder');
const MessageTemplate = require('../models/MessageTemplate');
const AdSpend = require('../models/AdSpend');
const AdCampaignMapping = require('../models/AdCampaignMapping');

const TOKEN_EXPIRY = '30d'; // personal tool, favor not re-logging-in over short-lived tokens
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function normalizeMatchName(name) {
  return String(name || '').trim().toLowerCase();
}

// 4 base36 characters (0-9, A-Z) seeded by *both* the exact moment this is
// called (nanosecond-resolution) and a cryptographically random block - not
// just a counter - so the suffix is unguessable and never repeats even if
// called twice in the same millisecond.
function generateRandomOrderSuffix(length) {
  const timePart = process.hrtime.bigint().toString(36); // nanosecond-resolution clock
  const randomPart = crypto.randomBytes(16).toString('hex'); // OS entropy, not Math.random()
  const hash = crypto.createHash('sha256').update(`${timePart}:${randomPart}`).digest('hex');
  const big = BigInt(`0x${hash.slice(0, 16)}`);
  return big.toString(36).toUpperCase().padStart(length, '0').slice(-length);
}

// PPYYYYMMDDXXXX (no separators) - the date makes it sortable/readable at a
// glance (and still ties it to "when"), the 4 random chars make it
// unguessable within that day. Short enough to read off screen and hand-type
// into lincah's own "Kode Referensi" field. Retries on the (astronomically
// unlikely) chance of a same-day collision - the unique index on
// PreOrder.orderNumber is still the real guarantee, this just avoids a
// wasted round trip failing with a duplicate-key error on the common path.
async function getNextPreOrderNumber() {
  const now = new Date();
  const datePart = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((n, i) => String(n).padStart(i === 0 ? 4 : 2, '0'))
    .join('');
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `PP${datePart}${generateRandomOrderSuffix(4)}`;
    // eslint-disable-next-line no-await-in-loop
    const exists = await PreOrder.exists({ orderNumber: candidate });
    if (!exists) return candidate;
  }
  throw new Error('gagal membuat No. Order unik setelah beberapa percobaan');
}

// The matching cascade used by POST /api/orders/import - needed *before*
// deciding whether/how to create the Order at all, since a match also
// determines which Product the row resolves to (see that route). Most to
// least confident:
//   1. Reference code match (PreOrder.orderNumber === Order.refCode) - the
//      pre-order's own generated number, meant to be copied into lincah's
//      "Kode Referensi" field by hand when the order is actually placed
//      there. Exact and unambiguous whenever the user does that.
//   2. Resi match (PreOrder.noResi === Order.trackingNumber) - exact and
//      unambiguous too, just discovered later (once shipping exists).
//   3. Otherwise phone + product name (case/whitespace-insensitive), among
//      pre-orders dated on/before this order, picking the closest one -
//      unless there's a tie, which is left alone rather than guessed (a
//      wrong match is worse than none, since a pre-order is just a plan).
// Returns the matched pre-order doc, or null.
function findPreOrderMatch({ refCode, trackingNumber, customerPhone, productName, createdDate }, availablePreOrders) {
  if (refCode) {
    const m = availablePreOrders.find((p) => p.orderNumber && p.orderNumber === refCode);
    if (m) return m;
  }

  if (trackingNumber) {
    const m = availablePreOrders.find((p) => p.noResi && p.noResi === trackingNumber);
    if (m) return m;
  }

  if (!customerPhone || !productName || !createdDate) return null;
  const productKey = normalizeMatchName(productName);
  const candidates = availablePreOrders.filter((p) =>
    p.customerPhone === customerPhone &&
    normalizeMatchName(p.productName) === productKey &&
    p.orderDate && new Date(p.orderDate) <= new Date(createdDate)
  );
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate)); // closest-from-below first
  const closestGapMs = new Date(createdDate) - new Date(candidates[0].orderDate);
  const tiedClosest = candidates.filter((c) => new Date(createdDate) - new Date(c.orderDate) === closestGapMs);
  if (tiedClosest.length !== 1) return null; // ambiguous - leave alone

  return tiedClosest[0];
}

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

  // Lightweight user list any authenticated team member can read (just
  // id + email, no role/timestamps) - used to populate the "Dibuat oleh"
  // picker on Pra-Pesanan, so a CS account (non-admin) can still see who's
  // available to attribute an entry to without needing admin rights.
  app.get('/api/users/mini', requireAuth, async (req, res) => {
    try {
      const users = await User.find({}).select('email').lean();
      res.json({ users: users.map((u) => ({ id: u._id, email: u.email })) });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
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
        role: ['admin', 'cs'].includes(role) ? role : 'user',
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

  // ---- Products ----

  // weight in gram, volume in cm3, length/width/height in cm - all optional,
  // unlike name/price which every product needs.
  const PRODUCT_DIMENSION_FIELDS = ['weight', 'volume', 'length', 'width', 'height'];

  function parseProductDimensions(body) {
    const dims = {};
    for (const field of PRODUCT_DIMENSION_FIELDS) {
      const raw = body[field];
      if (raw === undefined || raw === null || raw === '') continue;
      const num = Number(raw);
      if (!Number.isFinite(num) || num < 0) {
        throw new Error(`${field} must be a non-negative number`);
      }
      dims[field] = num;
    }
    return dims;
  }

  function serializeProduct(doc) {
    const { _id, name, sku, warehouseAddress, price, hpp, weight, volume, length, width, height } = doc;
    return { id: _id, name, sku, warehouseAddress, price, hpp, weight, volume, length, width, height };
  }

  // HPP is optional (unlike price) - a product can exist before its cost
  // price is known, same reasoning as the dimension fields above.
  function parseHpp(body) {
    const raw = body.hpp;
    if (raw === undefined || raw === null || raw === '') return undefined;
    const num = Number(raw);
    if (!Number.isFinite(num) || num < 0) throw new Error('hpp must be a non-negative number');
    return num;
  }

  // "{part1}-{part2}" + the smallest sequence number (starting at 1, no
  // separator before it) not already taken by that exact base - so two
  // products entered with the same two parts still end up with distinct
  // SKUs instead of erroring out on the admin. Capped rather than looping
  // forever on the pathological case of thousands of products sharing a base.
  async function generateUniqueSku(part1, part2) {
    const base = `${part1}-${part2}`;
    for (let seq = 1; seq <= 9999; seq++) {
      const candidate = `${base}${seq}`;
      // eslint-disable-next-line no-await-in-loop
      const exists = await Product.exists({ sku: candidate });
      if (!exists) return candidate;
    }
    throw new Error(`terlalu banyak produk dengan kode SKU "${base}" - coba kode yang berbeda`);
  }

  app.get('/api/products', requireAuth, async (req, res) => {
    try {
      const docs = await Product.find({}).sort({ name: 1 }).lean();
      const products = docs.map(({ _id, __v, ...rest }) => ({ id: _id, ...rest }));
      res.json({ products });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.post('/api/products', requireAuth, async (req, res) => {
    try {
      const { name, price, skuPart1, skuPart2, warehouseAddress } = req.body || {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name is required' });
      }
      const priceNum = Number(price);
      if (!Number.isFinite(priceNum) || priceNum < 0) {
        return res.status(400).json({ error: 'price must be a non-negative number' });
      }
      if (!skuPart1 || typeof skuPart1 !== 'string' || !skuPart1.trim()) {
        return res.status(400).json({ error: 'Kode SKU bagian 1 wajib diisi' });
      }
      if (!skuPart2 || typeof skuPart2 !== 'string' || !skuPart2.trim()) {
        return res.status(400).json({ error: 'Kode SKU bagian 2 wajib diisi' });
      }
      let dims;
      let hpp;
      try {
        dims = parseProductDimensions(req.body || {});
        hpp = parseHpp(req.body || {});
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      const sku = await generateUniqueSku(skuPart1.trim(), skuPart2.trim());
      const product = await Product.create({
        name: name.trim(),
        price: priceNum,
        hpp,
        sku,
        warehouseAddress: warehouseAddress && String(warehouseAddress).trim() ? String(warehouseAddress).trim() : undefined,
        ...dims,
      });
      res.json({ ok: true, product: serializeProduct(product) });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.put('/api/products/:id', requireAuth, async (req, res) => {
    try {
      const { name, price, sku, warehouseAddress } = req.body || {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name is required' });
      }
      const priceNum = Number(price);
      if (!Number.isFinite(priceNum) || priceNum < 0) {
        return res.status(400).json({ error: 'price must be a non-negative number' });
      }
      let dims;
      let hpp;
      try {
        dims = parseProductDimensions(req.body || {});
        hpp = parseHpp(req.body || {});
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      // SKU is free-text on edit (not regenerated - see the schema comment)
      // but still has to stay unique, so check by hand rather than letting a
      // duplicate hit the unique index and surface as a raw Mongo error.
      const skuTrimmed = sku && String(sku).trim() ? String(sku).trim() : '';
      if (skuTrimmed) {
        const clash = await Product.findOne({ sku: skuTrimmed, _id: { $ne: req.params.id } }).lean();
        if (clash) return res.status(409).json({ error: `SKU "${skuTrimmed}" sudah dipakai produk lain (${clash.name})` });
      }
      const warehouseTrimmed = warehouseAddress && String(warehouseAddress).trim() ? String(warehouseAddress).trim() : '';

      // $unset any dimension/sku/warehouseAddress field not present in this
      // request, so clearing a field on the client (leaving it blank)
      // actually clears it server-side instead of leaving the old value behind.
      const unset = {};
      PRODUCT_DIMENSION_FIELDS.forEach((field) => {
        if (!(field in dims)) unset[field] = '';
      });
      if (!skuTrimmed) unset.sku = '';
      if (!warehouseTrimmed) unset.warehouseAddress = '';
      if (hpp === undefined) unset.hpp = '';

      const set = { name: name.trim(), price: priceNum, ...dims };
      if (skuTrimmed) set.sku = skuTrimmed;
      if (warehouseTrimmed) set.warehouseAddress = warehouseTrimmed;
      if (hpp !== undefined) set.hpp = hpp;

      const update = { $set: set };
      if (Object.keys(unset).length > 0) update.$unset = unset;
      const product = await Product.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
      if (!product) return res.status(404).json({ error: 'product not found' });
      res.json({ ok: true, product: serializeProduct(product) });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.delete('/api/products/:id', requireAuth, async (req, res) => {
    try {
      await Product.findByIdAndDelete(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ---- Message templates (extension's "Kabar Pra-Pesanan" quick replies) ----
  // Managed here, mirrored read-only into the extension - same pattern as
  // the Product catalog above (see wa-ektension/background.js
  // pullMessageTemplates). No CS/admin distinction: any authenticated user
  // can manage these, matching Product's own access level.

  app.get('/api/message-templates', requireAuth, async (req, res) => {
    try {
      const docs = await MessageTemplate.find({}).sort({ createdAt: 1 }).lean();
      const templates = docs.map(({ _id, __v, ...rest }) => ({ id: _id, ...rest }));
      res.json({ templates });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.post('/api/message-templates', requireAuth, async (req, res) => {
    try {
      const { label, text } = req.body || {};
      if (!label || !text) return res.status(400).json({ error: 'label and text are required' });
      const doc = await MessageTemplate.create({ label: String(label).trim(), text: String(text) });
      res.json({ ok: true, template: { id: doc._id, label: doc.label, text: doc.text } });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.put('/api/message-templates/:id', requireAuth, async (req, res) => {
    try {
      const { label, text } = req.body || {};
      if (!label || !text) return res.status(400).json({ error: 'label and text are required' });
      const doc = await MessageTemplate.findByIdAndUpdate(
        req.params.id,
        { $set: { label: String(label).trim(), text: String(text) } },
        { new: true }
      );
      if (!doc) return res.status(404).json({ error: 'template not found' });
      res.json({ ok: true, template: { id: doc._id, label: doc.label, text: doc.text } });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.delete('/api/message-templates/:id', requireAuth, async (req, res) => {
    try {
      await MessageTemplate.findByIdAndDelete(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ---- Orders (imported from the COD fulfillment export xlsx) ----

  const ORDER_REQUIRED_HEADERS = ['No. Order', 'Penerima', 'No. HP Penerima', 'Produk', 'Harga Produk'];
  const INDONESIAN_MONTHS = {
    jan: 0, feb: 1, mar: 2, apr: 3, mei: 4, jun: 5, jul: 6, agu: 7, ags: 7, sep: 8, okt: 9, nov: 10, des: 11,
  };

  function onlyDigits(value) {
    return String(value || '').replace(/\D/g, '');
  }

  // "Nomor Admin Gudang" in the export is 62-prefixed (e.g. 6285726435813),
  // but Chat.ownerNumber in this system is entered as local 0-prefixed
  // (e.g. 085726435813, matching the existing Akun WA filter values) - so an
  // order's admin number has to be converted to line up with it, or it'd
  // show up as a separate, unfiltered "account".
  function normalizeOwnerNumber(value) {
    const digits = onlyDigits(value);
    if (!digits) return '';
    return digits.startsWith('62') ? `0${digits.slice(2)}` : digits;
  }

  // Shared "what's this record's lead date" lookup, used everywhere a
  // Pesanan/Pra-Pesanan/Dashboard date filter offers "Tanggal Lead" as an
  // alternative to the record's own native date. Order.customerPhone and
  // most Chat._id values share the same local 0-prefixed digit format, but
  // PreOrder.customerPhone can be stored either 62-prefixed (rows imported
  // via "Impor dari Lincah", see normalizePreOrderPhone) or local (rows
  // added by hand) - and a handful of Chat rows created from a 62-prefixed
  // PreOrder import ended up with a 62-prefixed _id too. Trying both the
  // phone as-is and its normalized-to-local form covers every combination
  // without needing to backfill/rewrite any existing phone/_id values.
  function leadDateForPhone(phone, chatByPhone) {
    if (!phone) return undefined;
    const chat = chatByPhone.get(phone) || chatByPhone.get(normalizeOwnerNumber(phone));
    return chat ? chat.firstMessageDate : undefined;
  }

  // Shared "sedang bermasalah" rule - used by the Dashboard/Laporan cards,
  // the Pesanan page's own filter, and GET /api/orders?problematic=true
  // (which the extension polls to badge WhatsApp chats with a currently
  // problematic order). The source xlsx export fills every row's Problem
  // cell with literally "-" when there's nothing wrong (not a blank cell),
  // so a plain non-empty check would treat every single order as
  // "problematic" - has to be excluded explicitly. "Sedang bermasalah" =
  // catatan Problem terisi (bukan "-") DAN status belum final (bukan
  // Diterima/Return/Dibatalkan) - begitu order itu resolve ke salah satu
  // status final, paketnya sudah melewati apa pun yang memicu catatan itu,
  // jadi tidak lagi dihitung sebagai masalah AKTIF walau catatan Problem-nya
  // sendiri tetap tersimpan sebagai histori.
  function isProblematicOrder(o) {
    const problem = (o.problem || '').trim();
    return problem !== '' && problem !== '-' &&
      !['Diterima', 'Return', 'Dibatalkan'].includes(o.status);
  }

  function numOrUndefined(value) {
    if (value === undefined || value === null || value === '') return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }

  // Source dates are plain text like "Kamis, 23 Jul 2026" (day name, day,
  // Indonesian month abbreviation, year) - not native Excel date cells.
  function parseIndonesianDate(value) {
    if (!value) return undefined;
    const match = String(value).match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
    if (!match) return undefined;
    const [, day, monthStr, year] = match;
    const month = INDONESIAN_MONTHS[monthStr.toLowerCase().slice(0, 3)];
    if (month === undefined) return undefined;
    const date = new Date(Number(year), month, Number(day));
    return isNaN(date.getTime()) ? undefined : date;
  }

  // ?notifyResi=true narrows this down to orders the extension's per-chat
  // "Kabari Resi" badge cares about: already has a tracking number, and not
  // yet in a final state ("Diterima" = delivered, nothing left to tell the
  // customer; "Dibatalkan" = cancelled, no resi is relevant). Same shape as
  // the unfiltered response - the extension only reads a few fields off each
  // one - so this stays a plain filter on the existing route instead of a
  // separate endpoint.
  // ?problematic=true narrows this down to the same "sedang bermasalah" set
  // as isProblematicOrder() (Dashboard/Laporan/Pesanan) - used by the
  // extension to badge WhatsApp chats whose phone has a currently
  // problematic order. Expressed here as a Mongo-level filter (rather than
  // fetching everything and filtering in JS) since both conditions are
  // static field comparisons.
  app.get('/api/orders', requireAuth, async (req, res) => {
    try {
      const filter = {};
      if (req.query.notifyResi === 'true') {
        filter.status = { $nin: ['Dibatalkan', 'Diterima'] };
        filter.trackingNumber = { $nin: [null, ''] };
      }
      if (req.query.problematic === 'true') {
        filter.problem = { $nin: [null, '', '-'] };
        filter.status = { $nin: ['Diterima', 'Return', 'Dibatalkan'] };
      }
      const [docs, chats] = await Promise.all([
        Order.find(filter).sort({ createdDate: -1 }).lean(),
        Chat.find({}, { firstMessageDate: 1 }).lean(),
      ]);
      const chatByPhone = new Map(chats.map((c) => [c._id, c]));
      // leadDate lets the Pesanan page's "Berdasarkan Tanggal" filter offer
      // Tanggal Lead as an alternative to createdDate without a second
      // request - the extension (the other consumer of this route) simply
      // never reads this extra field.
      const orders = docs.map(({ _id, __v, ...rest }) => ({
        id: _id, ...rest, leadDate: leadDateForPhone(rest.customerPhone, chatByPhone),
      }));
      res.json({ orders });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.put('/api/orders/:id', requireAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const productName = body.productName ? String(body.productName).trim() : undefined;
      let productId;
      if (productName) {
        let product = await Product.findOne({ name: productName });
        if (!product) product = await Product.create({ name: productName });
        productId = product._id;
      }

      const order = await Order.findByIdAndUpdate(
        req.params.id,
        {
          $set: {
            shippingType: body.shippingType,
            courier: body.courier,
            customerName: body.customerName,
            customerPhone: body.customerPhone ? onlyDigits(body.customerPhone) : undefined,
            address: body.address,
            city: body.city,
            productName,
            productId,
            weight: numOrUndefined(body.weight),
            qty: numOrUndefined(body.qty),
            volume: body.volume,
            shippingCost: numOrUndefined(body.shippingCost),
            codDiscount: numOrUndefined(body.codDiscount),
            codFee: numOrUndefined(body.codFee),
            price: numOrUndefined(body.price),
            hpp: numOrUndefined(body.hpp),
            codValue: numOrUndefined(body.codValue),
            status: body.status,
            trackingNumber: body.trackingNumber,
            createdDate: body.createdDate ? new Date(body.createdDate) : undefined,
            receivedDate: body.receivedDate ? new Date(body.receivedDate) : undefined,
            note: body.note,
            refCode: body.refCode,
            reconciliationStatus: body.reconciliationStatus,
            warehouseAdminName: body.warehouseAdminName,
            ownerNumber: body.ownerNumber,
            zipcode: body.zipcode,
            regency: body.regency,
            district: body.district,
            province: body.province,
            variant: body.variant,
            problem: body.problem,
            returnDate: body.returnDate ? new Date(body.returnDate) : undefined,
            returnToSellerDate: body.returnToSellerDate ? new Date(body.returnToSellerDate) : undefined,
            csName: body.csName,
            pickupType: body.pickupType,
            pickupTime: body.pickupTime,
            insurance: body.insurance,
            originalShippingCost: numOrUndefined(body.originalShippingCost),
            senderDistrict: body.senderDistrict,
            senderRegency: body.senderRegency,
            senderProvince: body.senderProvince,
            senderAddress: body.senderAddress,
          },
        },
        { new: true }
      );
      if (!order) return res.status(404).json({ error: 'order not found' });
      const { _id, __v, ...rest } = order.toObject();
      res.json({ ok: true, order: { id: _id, ...rest } });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Follow-up log (see wa-ektension's "Riwayat Follow Up") - the extension
  // only calls this once a CS explicitly confirms a template was actually
  // sent (a template merely picked/inserted stays local-only in
  // chrome.storage and never reaches here), so every row this creates is a
  // genuinely-sent follow-up, not just an attempt.
  app.post('/api/orders/:id/followups', requireAuth, async (req, res) => {
    try {
      const { templateLabel, ownerNumber } = req.body || {};
      if (!templateLabel) return res.status(400).json({ error: 'templateLabel is required' });
      const entry = { templateLabel: String(templateLabel), ownerNumber, sentAt: new Date() };
      const order = await Order.findByIdAndUpdate(
        req.params.id,
        { $push: { followUps: entry } },
        { new: true }
      );
      if (!order) return res.status(404).json({ error: 'order not found' });
      const saved = order.followUps[order.followUps.length - 1];
      res.json({ ok: true, followUp: { id: saved._id, templateLabel: saved.templateLabel, ownerNumber: saved.ownerNumber, sentAt: saved.sentAt } });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Undo - a CS un-toggling "Sudah Dikirim" back to "Belum Dikirim" (marked
  // it by mistake) removes the entry entirely rather than leaving a
  // contradicted record, since there's no in-between state for this log.
  app.delete('/api/orders/:id/followups/:followupId', requireAuth, async (req, res) => {
    try {
      const order = await Order.findByIdAndUpdate(
        req.params.id,
        { $pull: { followUps: { _id: req.params.followupId } } },
        { new: true }
      );
      if (!order) return res.status(404).json({ error: 'order not found' });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Deleting an Order without also clearing any PreOrder.convertedOrderId
  // pointing to it leaves that pre-order permanently stuck: findPreOrderMatch
  // only searches PreOrders with no convertedOrderId, so a "converted" one
  // whose Order got deleted can never be matched (or re-import its Order)
  // again - it just silently disappears from the active Pra-Pesanan list
  // with nothing pointing back at it. Clearing convertedOrderId/convertedAt
  // here un-converts it, so it's active again and importable like any other.
  async function revertPreOrdersConvertedInto(orderIds) {
    await PreOrder.updateMany(
      { convertedOrderId: { $in: orderIds } },
      { $unset: { convertedOrderId: '', convertedAt: '' } }
    );
  }

  app.delete('/api/orders/:id', requireAuth, async (req, res) => {
    try {
      await Order.findByIdAndDelete(req.params.id);
      await revertPreOrdersConvertedInto([req.params.id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.post('/api/orders/delete', requireAuth, async (req, res) => {
    try {
      const { ids } = req.body || {};
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'body must be { ids: [...] }' });
      }
      const result = await Order.deleteMany({ _id: { $in: ids } });
      await revertPreOrdersConvertedInto(ids);
      res.json({ ok: true, deletedCount: result.deletedCount });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ?onlyMatched=true restricts this import to rows that match an existing
  // Pra-Pesanan (see findPreOrderMatch above) - anything unmatched is
  // skipped entirely rather than added as a new Order. Omitted/false imports
  // every row unconditionally, matching being an afterward side effect either
  // way (matching always runs; the flag only controls whether a miss skips
  // the row or not).
  //
  // Every row's product is resolved, never created: the matched Pra-Pesanan's
  // own catalog product wins first, then an exact-name match already in the
  // Product catalog, then whatever the admin explicitly chose via
  // `productMapping`. A row whose product can't be resolved by any of those
  // is skipped, not imported with a guessed/blank product.
  //
  // ?dryRun=true runs the exact same resolution pass without writing
  // anything to the database, and returns `unresolvedProducts` - the distinct
  // raw product names (from the file) nothing above could resolve. The
  // frontend shows a popup letting the admin map each to an existing catalog
  // product, then re-submits the same file with `productMapping` (a JSON
  // string sent as a normal multipart field: `{ "<raw name>": { "productId":
  // "...", "productName": "..." } }`) on the real, non-dry-run call.
  app.post('/api/orders/import', requireAuth, upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'file is required (field name "file")' });

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer);
      const worksheet = workbook.worksheets[0];
      if (!worksheet) return res.status(400).json({ error: 'file has no sheets' });

      const headerMap = {};
      worksheet.getRow(1).eachCell((cell, colNumber) => {
        headerMap[String(cell.value || '').trim()] = colNumber;
      });

      const missingHeaders = ORDER_REQUIRED_HEADERS.filter((h) => !headerMap[h]);
      if (missingHeaders.length > 0) {
        return res.status(400).json({ error: `Kolom wajib tidak ditemukan di file: ${missingHeaders.join(', ')}` });
      }

      const getCell = (row, header) => {
        const col = headerMap[header];
        if (!col) return undefined;
        const v = row.getCell(col).value;
        if (v === null || v === undefined || v === '') return undefined;
        if (typeof v === 'object' && 'text' in v) return v.text; // rich text
        if (typeof v === 'object' && 'result' in v) return v.result; // formula
        return v;
      };

      // HPP is looked up by productId regardless of which of the three ways
      // below resolved it (matched PreOrder, exact catalog name, or the
      // admin's productMapping) - none of those paths carry hpp themselves.
      const productHppById = new Map(
        (await Product.find({}, 'hpp').lean()).map((p) => [String(p._id), p.hpp])
      );

      const dryRun = req.query.dryRun === 'true';
      const onlyMatched = req.query.onlyMatched === 'true';
      let productMapping = {};
      if (req.body.productMapping) {
        try {
          productMapping = JSON.parse(req.body.productMapping);
        } catch (e) {
          // Malformed mapping just leaves those rows unresolved below.
        }
      }

      let availablePreOrders = await PreOrder.find({ convertedOrderId: { $exists: false } }).lean();
      const productCache = new Map(); // raw name -> {productId, productName} | null (unresolved)
      const unresolvedProducts = new Set();
      const preOrderConversionOps = [];
      // Order/Chat writes are queued here and sent as a couple of bulkWrite
      // calls after the loop, instead of one await per row (an earlier
      // version did `await Order.findByIdAndUpdate(...)` etc. for every
      // single row) - for a real-size file that's easily 100+ sequential
      // MongoDB round trips, slow enough to blow past the Netlify function's
      // execution time limit and get killed mid-request, which surfaces to
      // the browser as a bare "502 Bad Gateway" with no useful error message.
      const orderBulkOps = [];
      const chatBulkOps = [];

      // Chats are looked up by phone constantly below - batch-fetch every
      // phone this file references in one query up front (keyed in
      // `chatCache`) instead of one Chat.findById per row, same reasoning as
      // the bulk writes above.
      const allPhones = new Set();
      const allNoOrders = new Set();
      for (let r = 2; r <= worksheet.rowCount; r++) {
        const row = worksheet.getRow(r);
        const noOrderPrescan = String(getCell(row, 'No. Order') || '').trim();
        if (!noOrderPrescan) continue;
        allNoOrders.add(noOrderPrescan);
        const phone = onlyDigits(getCell(row, 'No. HP Penerima'));
        if (phone) allPhones.add(phone);
      }
      const existingChats = allPhones.size > 0
        ? await Chat.find({ _id: { $in: Array.from(allPhones) } }).lean()
        : [];
      const chatCache = new Map(existingChats.map((c) => [c._id, c])); // phone -> chat doc (plain object, not a live Mongoose doc)

      // HPP is frozen once set - re-importing (e.g. a later export of the
      // same order, or the same file again) must never overwrite it just
      // because the master Product's hpp changed since. Only orders that
      // don't already have an hpp value get one filled in below.
      const existingOrderHpp = allNoOrders.size > 0
        ? await Order.find({ _id: { $in: Array.from(allNoOrders) }, hpp: { $exists: true, $ne: null } }, 'hpp').lean()
        : [];
      const existingOrderHppIds = new Set(existingOrderHpp.map((o) => o._id));

      let ordersImported = 0;
      let contactsCreated = 0;
      let rowsSkipped = 0;
      let rowsUnmatchedSkipped = 0;
      let rowsProductUnresolvedSkipped = 0;

      for (let r = 2; r <= worksheet.rowCount; r++) {
        const row = worksheet.getRow(r);
        const noOrder = String(getCell(row, 'No. Order') || '').trim();
        if (!noOrder) continue; // blank/trailing row

        const productName = String(getCell(row, 'Produk') || '').trim();
        const customerName = String(getCell(row, 'Penerima') || '').trim();
        const customerPhone = onlyDigits(getCell(row, 'No. HP Penerima'));
        const status = String(getCell(row, 'Status') || '').trim();
        const ownerNumber = normalizeOwnerNumber(getCell(row, 'Nomor Admin Gudang'));
        const createdDate = parseIndonesianDate(getCell(row, 'Tanggal Dibuat'));
        const trackingNumber = getCell(row, 'Resi');
        const refCode = getCell(row, 'Kode Referensi');

        if (!customerPhone) {
          rowsSkipped++;
          continue;
        }

        const matchedPreOrder = findPreOrderMatch(
          { refCode, trackingNumber, customerPhone, productName, createdDate },
          availablePreOrders
        );
        if (onlyMatched && !matchedPreOrder) {
          rowsUnmatchedSkipped++;
          continue;
        }
        if (matchedPreOrder) {
          // Don't let a later row in the same file match this pre-order again.
          availablePreOrders = availablePreOrders.filter((p) => String(p._id) !== String(matchedPreOrder._id));
        }

        // Resolve this row's product - see the route comment above for the
        // priority order. Never creates a Product.
        let resolvedProduct = null;
        if (matchedPreOrder && matchedPreOrder.productId) {
          resolvedProduct = { productId: matchedPreOrder.productId, productName: matchedPreOrder.productName };
        } else if (productName) {
          if (productCache.has(productName)) {
            resolvedProduct = productCache.get(productName);
          } else {
            const exact = await Product.findOne({ name: productName }).lean();
            resolvedProduct = exact
              ? { productId: exact._id, productName: exact.name }
              : (productMapping[productName] || null);
            productCache.set(productName, resolvedProduct);
          }
        }

        if (!resolvedProduct) {
          if (productName) unresolvedProducts.add(productName);
          if (!dryRun) rowsProductUnresolvedSkipped++;
          continue;
        }

        if (dryRun) continue; // preview only - no writes below this point

        // Match the contact by phone number, creating it if this is a buyer
        // we haven't seen before (e.g. never scanned from WA Web). Queued
        // into chatBulkOps below instead of writing immediately - see the
        // comment above chatCache's declaration.
        let chat = chatCache.get(customerPhone);
        if (chat === undefined) {
          const newChat = {
            _id: customerPhone,
            name: customerName,
            phone: customerPhone,
            ownerNumber: ownerNumber || undefined,
            firstMessageDate: createdDate ? createdDate.toISOString() : undefined,
            firstSeenAt: new Date().toISOString(),
            manualClosing: status !== 'Dibatalkan',
            manualClosingUpdatedAt: new Date().toISOString(),
          };
          chatBulkOps.push({ updateOne: { filter: { _id: customerPhone }, update: { $set: newChat }, upsert: true } });
          contactsCreated++;
          chatCache.set(customerPhone, newChat);
          chat = newChat;
        } else if (status !== 'Dibatalkan' && chat.manualClosing !== true) {
          // A real order is a conversion regardless of shipping status - only
          // a cancelled order shouldn't flip an existing contact.
          chat.manualClosing = true;
          chat.manualClosingUpdatedAt = new Date().toISOString();
          chatBulkOps.push({
            updateOne: {
              filter: { _id: customerPhone },
              update: { $set: { manualClosing: true, manualClosingUpdatedAt: chat.manualClosingUpdatedAt } },
            },
          });
        }

        const volumeRaw = getCell(row, 'Volume');
        const zipcodeRaw = getCell(row, 'Zipcode');

        orderBulkOps.push({
          updateOne: {
            filter: { _id: noOrder },
            update: {
              $set: {
                _id: noOrder,
                shippingType: getCell(row, 'Pengiriman'),
                courier: getCell(row, 'Kurir'),
                customerName,
                customerPhone,
                address: getCell(row, 'Alamat'),
                city: getCell(row, 'Kota penerima'),
                productName: resolvedProduct.productName,
                productId: resolvedProduct.productId,
                weight: numOrUndefined(getCell(row, 'Berat')),
                qty: numOrUndefined(getCell(row, 'Jumlah')),
                volume: volumeRaw !== undefined ? String(volumeRaw) : undefined,
                shippingCost: numOrUndefined(getCell(row, 'Ongkos Kirim')),
                codDiscount: numOrUndefined(getCell(row, 'Diskon COD')),
                codFee: numOrUndefined(getCell(row, 'Biaya COD')),
                // "Harga Produk" is blank in every row of this export format -
                // the real per-order price ends up in "Nilai COD" instead.
                // Prefer "Harga Produk" when a future export does fill it in.
                price: numOrUndefined(getCell(row, 'Harga Produk')) ?? numOrUndefined(getCell(row, 'Nilai COD')),
                hpp: existingOrderHppIds.has(noOrder)
                  ? undefined // already frozen - don't let a re-import refresh it to a since-changed master hpp
                  : (resolvedProduct.productId ? productHppById.get(String(resolvedProduct.productId)) : undefined),
                codValue: numOrUndefined(getCell(row, 'Nilai COD')),
                status,
                trackingNumber,
                createdDate,
                receivedDate: parseIndonesianDate(getCell(row, 'Tanggal Diterima')),
                note: getCell(row, 'Catatan'),
              refCode,
              reconciliationStatus: getCell(row, 'Status Rekonsiliasi'),
              warehouseAdminName: getCell(row, 'Nama Admin Gudang'),
                ownerNumber,
                zipcode: zipcodeRaw !== undefined ? String(zipcodeRaw) : undefined,
                regency: getCell(row, 'Kota/Kabupaten'),
                district: getCell(row, 'Kecamatan'),
                province: getCell(row, 'Provinsi'),
                variant: getCell(row, 'Variasi'),
                problem: getCell(row, 'Problem'),
                returnDate: parseIndonesianDate(getCell(row, 'Tanggal Return')),
                returnToSellerDate: parseIndonesianDate(getCell(row, 'Tanggal Return Ke Seller')),
                csName: getCell(row, 'Nama CS'),
                pickupType: getCell(row, 'Tipe Pickup'),
                pickupTime: getCell(row, 'Waktu Pickup') !== undefined ? String(getCell(row, 'Waktu Pickup')) : undefined,
                insurance: getCell(row, 'Asuransi'),
                originalShippingCost: numOrUndefined(getCell(row, 'Ongkos Kirim Asli')),
                senderDistrict: getCell(row, 'Kecamatan Pengirim'),
                senderRegency: getCell(row, 'Kota/Kabupaten Pengirim'),
                senderProvince: getCell(row, 'Provinsi Pengirim'),
                senderAddress: getCell(row, 'Alamat Pengirim'),
              },
            },
            upsert: true,
          },
        });
        ordersImported++;

        if (matchedPreOrder) {
          preOrderConversionOps.push({
            updateOne: {
              filter: { _id: matchedPreOrder._id },
              // A match here means this row - from the actual lincah.id order
              // export - is the real order this pre-order graduated into, so
              // LINCAH gets ticked automatically same as it would from the
              // "Data Order" sheet's own LINCAH column (see
              // POST /api/preorders/import) - the admin shouldn't have to
              // re-tick it by hand for every row this import already confirms.
              update: { $set: { convertedOrderId: noOrder, convertedAt: new Date(), lincah: true } },
            },
          });
        }
      }

      if (dryRun) {
        return res.json({ dryRun: true, unresolvedProducts: Array.from(unresolvedProducts) });
      }

      // The handful of DB round trips this import actually needs now - see
      // the comment above chatBulkOps/orderBulkOps for why these are batched
      // instead of one write per row.
      if (chatBulkOps.length > 0) await Chat.bulkWrite(chatBulkOps);
      if (orderBulkOps.length > 0) await Order.bulkWrite(orderBulkOps);
      if (preOrderConversionOps.length > 0) await PreOrder.bulkWrite(preOrderConversionOps);
      const preOrdersMoved = preOrderConversionOps.length;

      res.json({
        ok: true,
        ordersImported,
        contactsCreated,
        rowsSkipped,
        rowsUnmatchedSkipped,
        rowsProductUnresolvedSkipped,
        preOrdersMoved,
      });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  const PROBLEM_TRACKING_REQUIRED_HEADERS = ['No. Order', 'Status Terakhir'];

  // A separate, narrower export than the main Pesanan import above - only
  // covers orders currently stuck with a courier, with the shipping-cost
  // breakdown (Ongkir Berangkat/Pulang, Potensi RTS) and problem history the
  // main export doesn't carry. Matched to an existing Order by "No. Order"
  // (the same _id the main import uses) and only updates these
  // problem-tracking fields - never creates a new Order (a row whose No.
  // Order isn't already in the system is skipped and counted, not inserted,
  // since this file has none of the other required Order fields). Re-running
  // this with a fresher export is the expected, normal way to refresh these
  // fields while an order is still stuck - see the Order model comment for
  // why a resolved order doesn't need any explicit "clear" step here.
  app.post('/api/orders/import-problem-tracking', requireAuth, upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'file is required (field name "file")' });

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer);
      const worksheet = workbook.worksheets[0];
      if (!worksheet) return res.status(400).json({ error: 'file has no sheets' });

      const headerMap = {};
      worksheet.getRow(1).eachCell((cell, colNumber) => {
        headerMap[String(cell.value || '').trim()] = colNumber;
      });

      const missingHeaders = PROBLEM_TRACKING_REQUIRED_HEADERS.filter((h) => !headerMap[h]);
      if (missingHeaders.length > 0) {
        return res.status(400).json({ error: `Kolom wajib tidak ditemukan di file: ${missingHeaders.join(', ')}` });
      }

      const getCell = (row, header) => {
        const col = headerMap[header];
        if (!col) return undefined;
        const v = row.getCell(col).value;
        if (v === null || v === undefined || v === '') return undefined;
        if (typeof v === 'object' && v instanceof Date) return v;
        if (typeof v === 'object' && 'text' in v) return v.text; // rich text
        if (typeof v === 'object' && 'result' in v) return v.result; // formula
        return v;
      };

      const noOrders = [];
      const rowByNoOrder = new Map();
      for (let r = 2; r <= worksheet.rowCount; r++) {
        const row = worksheet.getRow(r);
        const noOrder = String(getCell(row, 'No. Order') || '').trim();
        if (!noOrder) continue;
        noOrders.push(noOrder);
        rowByNoOrder.set(noOrder, row);
      }

      const existingOrders = await Order.find({ _id: { $in: noOrders } }, { _id: 1 }).lean();
      const existingIds = new Set(existingOrders.map((o) => o._id));

      const ops = [];
      let rowsNotFoundSkipped = 0;
      rowByNoOrder.forEach((row, noOrder) => {
        if (!existingIds.has(noOrder)) {
          rowsNotFoundSkipped++;
          return;
        }
        ops.push({
          updateOne: {
            filter: { _id: noOrder },
            update: {
              $set: {
                ongkirBerangkat: numOrUndefined(getCell(row, 'Ongkir Berangkat')),
                ongkirPulang: numOrUndefined(getCell(row, 'Ongkir Pulang')),
                potensiRTS: numOrUndefined(getCell(row, 'Potensi RTS')),
                problemStatusTerakhir: getCell(row, 'Status Terakhir'),
                problemKategori: getCell(row, 'Kategori Problem'),
                problemBuktiKurir: getCell(row, 'Bukti Kurir'),
                problemRiwayat: getCell(row, 'Last 5 Problem Detail'),
                problemUpdatedAt: getCell(row, 'Tanggal Update Terakhir'),
              },
            },
          },
        });
      });

      if (ops.length > 0) await Order.bulkWrite(ops);

      res.json({ ok: true, updated: ops.length, rowsNotFoundSkipped });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ---- Pre-Orders (Pra-Pesanan - manually tracked, CRUD, before an order is
  // actually placed on lincah.id) ----

  const PREORDER_REQUIRED_HEADERS = ['Tanggal Order', 'Nama Customer', 'No HP/WA', 'Produk'];

  // "No HP/WA" is often stored as a plain number, which silently drops a
  // leading 0 (Excel numbers don't have one) - reconstruct the local
  // 0-prefix before converting to the 62-prefixed format Order.customerPhone
  // uses, so matching against real lincah orders actually works.
  function normalizePreOrderPhone(value) {
    const digits = onlyDigits(value);
    if (!digits) return '';
    if (digits.startsWith('62')) return digits;
    if (digits.startsWith('0')) return `62${digits.slice(1)}`;
    return `62${digits}`;
  }

  function preOrderDedupKey(phone, productName, orderDate) {
    const dateKey = orderDate ? new Date(orderDate).toISOString().slice(0, 10) : '';
    return `${phone || ''}|${normalizeMatchName(productName)}|${dateKey}`;
  }

  function serializePreOrder(doc) {
    const obj = typeof doc.toObject === 'function' ? doc.toObject() : doc;
    const { _id, __v, ...rest } = obj;
    return { id: _id, ...rest };
  }

  // Same Product/Contact auto-create pattern used by the Order import - a
  // pre-order never touches manualClosing though, since it isn't a confirmed
  // conversion yet (that's what the actual Order represents).
  async function resolvePreOrderRefs({ productName, customerPhone, customerName, orderDate }) {
    // Never auto-creates a Product - the form's Produk field is already a
    // dropdown of existing catalog products, so this only matters for the
    // rare case of an edit resubmitting a name that's since been renamed or
    // deleted from the catalog; left unresolved (undefined) rather than
    // silently spawning a duplicate.
    let productId;
    if (productName) {
      const product = await Product.findOne({ name: productName }).lean();
      if (product) productId = product._id;
    }
    if (customerPhone) {
      const existingChat = await Chat.findById(customerPhone);
      if (!existingChat) {
        await Chat.create({
          _id: customerPhone,
          name: customerName,
          phone: customerPhone,
          firstMessageDate: orderDate ? new Date(orderDate).toISOString() : undefined,
          firstSeenAt: new Date().toISOString(),
        });
      }
    }
    return productId;
  }

  // The creator is a business attribution field, not a security/audit one -
  // the user explicitly wants to be able to pick which CS entered an order
  // (e.g. owner backfilling on someone's behalf), not just auto-stamp
  // whoever is logged in. body.createdByUserId (from the form's dropdown)
  // wins when it names a real user; otherwise fall back to the session.
  async function resolvePreOrderCreator(req, body) {
    if (body.createdByUserId) {
      const user = await User.findById(body.createdByUserId).select('email').lean();
      if (user) return { createdByUserId: String(user._id), createdByEmail: user.email };
    }
    if (req.auth.type === 'user') {
      return { createdByUserId: req.auth.userId, createdByEmail: req.auth.email };
    }
    return { createdByUserId: undefined, createdByEmail: undefined };
  }

  function preOrderFieldsFromBody(body) {
    return {
      customerName: body.customerName,
      address: body.address,
      qty: numOrUndefined(body.qty),
      unitPrice: numOrUndefined(body.unitPrice),
      hpp: numOrUndefined(body.hpp),
      totalPrice: numOrUndefined(body.totalPrice),
      shippingCost: numOrUndefined(body.shippingCost),
      totalBill: numOrUndefined(body.totalBill),
      paymentMethod: body.paymentMethod,
      paymentStatus: body.paymentStatus,
      courier: body.courier,
      noResi: body.noResi,
      statusOrder: body.statusOrder,
      campaignSource: body.campaignSource,
      note: body.note,
      lincah: body.lincah === true,
      aneka: body.aneka === true,
      ctt: body.ctt,
    };
  }

  // ?status=active (default) - not yet converted, the "disappears once it
  // becomes a real order" list the UI has always shown.
  // ?status=converted - only the ones that already graduated into a Pesanan
  // (used by the Pra-Pesanan page's "Sudah jadi Pesanan" filter).
  // ?status=all - both, used for GET /api/dashboard/stats' historical
  // conversion counting.
  app.get('/api/preorders', requireAuth, async (req, res) => {
    try {
      const status = req.query.status || (req.query.includeConverted === 'true' ? 'all' : 'active');
      const filter = status === 'all' ? {}
        : status === 'converted' ? { convertedOrderId: { $exists: true } }
        : { convertedOrderId: { $exists: false } };
      const [docs, chats] = await Promise.all([
        PreOrder.find(filter).sort({ orderDate: -1 }).lean(),
        Chat.find({}, { firstMessageDate: 1 }).lean(),
      ]);
      const chatByPhone = new Map(chats.map((c) => [c._id, c]));
      const preOrders = docs.map(({ _id, __v, ...rest }) => ({
        id: _id, ...rest, leadDate: leadDateForPhone(rest.customerPhone, chatByPhone),
      }));
      res.json({ preOrders });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.post('/api/preorders', requireAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const customerPhone = body.customerPhone ? onlyDigits(body.customerPhone) : undefined;
      const productName = body.productName ? String(body.productName).trim() : undefined;
      const orderDate = body.orderDate ? new Date(body.orderDate) : undefined;

      const productId = await resolvePreOrderRefs({
        productName, customerPhone, customerName: body.customerName, orderDate,
      });
      const creator = await resolvePreOrderCreator(req, body);
      const orderNumber = await getNextPreOrderNumber();

      const preOrder = await PreOrder.create({
        ...preOrderFieldsFromBody(body),
        ...creator,
        orderNumber,
        orderDate,
        customerPhone,
        productName,
        productId,
      });
      res.json({ ok: true, preOrder: serializePreOrder(preOrder) });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.put('/api/preorders/:id', requireAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const customerPhone = body.customerPhone ? onlyDigits(body.customerPhone) : undefined;
      const productName = body.productName ? String(body.productName).trim() : undefined;
      const orderDate = body.orderDate ? new Date(body.orderDate) : undefined;

      const productId = await resolvePreOrderRefs({
        productName, customerPhone, customerName: body.customerName, orderDate,
      });
      // Only reassign the creator if the form actually sent one - orderNumber
      // is never touched here, it's set once at creation and stays put.
      const creator = body.createdByUserId ? await resolvePreOrderCreator(req, body) : {};

      const preOrder = await PreOrder.findByIdAndUpdate(
        req.params.id,
        { $set: { ...preOrderFieldsFromBody(body), ...creator, orderDate, customerPhone, productName, productId } },
        { new: true }
      );
      if (!preOrder) return res.status(404).json({ error: 'pre-order not found' });
      res.json({ ok: true, preOrder: serializePreOrder(preOrder) });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Separate, single-field route rather than folding this into the general
  // PUT /api/preorders/:id above - that route always rewrites orderDate/
  // customerPhone/productName/productId from the request body (the edit
  // form always sends the full record), so a partial `{ responseStatus }`
  // body through it would risk blanking out those fields. This one only
  // ever touches responseStatus, so the dashboard's Status Respon pill can
  // send just that with no risk to the rest of the row.
  const RESPONSE_STATUS_VALUES = ['belum_membalas', 'jadi_dikirim', 'dibatalkan'];
  app.put('/api/preorders/:id/response-status', requireAuth, async (req, res) => {
    try {
      const { responseStatus } = req.body || {};
      if (!RESPONSE_STATUS_VALUES.includes(responseStatus)) {
        return res.status(400).json({ error: `responseStatus must be one of: ${RESPONSE_STATUS_VALUES.join(', ')}` });
      }
      const preOrder = await PreOrder.findByIdAndUpdate(
        req.params.id,
        { $set: { responseStatus } },
        { new: true }
      );
      if (!preOrder) return res.status(404).json({ error: 'pre-order not found' });
      res.json({ ok: true, preOrder: serializePreOrder(preOrder) });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.delete('/api/preorders/:id', requireAuth, async (req, res) => {
    try {
      await PreOrder.findByIdAndDelete(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.post('/api/preorders/delete', requireAuth, async (req, res) => {
    try {
      const { ids } = req.body || {};
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'body must be { ids: [...] }' });
      }
      const result = await PreOrder.deleteMany({ _id: { $in: ids } });
      res.json({ ok: true, deletedCount: result.deletedCount });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // LINCAH gets set automatically from the "Data Order" sheet's own LINCAH
  // column on import (see POST /api/preorders/import above) - ANEKA has no
  // such source and has always had to be ticked one row at a time in the
  // edit form. This is a bulk alternative using the same row-selection
  // checkboxes the table already has for "Hapus yang Dipilih" - a separate,
  // single-field bulkWrite rather than looping the general PUT /:id per row,
  // so it can't accidentally touch any other field on the selected rows.
  app.post('/api/preorders/bulk-aneka', requireAuth, async (req, res) => {
    try {
      const { ids, aneka } = req.body || {};
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'body must be { ids: [...], aneka: boolean }' });
      }
      const result = await PreOrder.updateMany({ _id: { $in: ids } }, { $set: { aneka: aneka === true } });
      res.json({ ok: true, modifiedCount: result.modifiedCount });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.post('/api/preorders/import', requireAuth, upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'file is required (field name "file")' });

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer);
      const worksheet = workbook.getWorksheet('Data Order') || workbook.worksheets[0];
      if (!worksheet) return res.status(400).json({ error: 'file has no sheets' });

      // The sheet has a title banner above the real header row, so scan the
      // first few rows for one that actually has all the columns we need,
      // instead of assuming the header is always row 1.
      let headerMap = null;
      let headerRowNumber = null;
      for (let r = 1; r <= Math.min(5, worksheet.rowCount); r++) {
        const candidate = {};
        worksheet.getRow(r).eachCell((cell, col) => {
          candidate[String(cell.value || '').trim()] = col;
        });
        if (PREORDER_REQUIRED_HEADERS.every((h) => candidate[h])) {
          headerMap = candidate;
          headerRowNumber = r;
          break;
        }
      }
      if (!headerMap) {
        return res.status(400).json({
          error: `Kolom wajib tidak ditemukan di 5 baris pertama: ${PREORDER_REQUIRED_HEADERS.join(', ')}`,
        });
      }

      const getCell = (row, header) => {
        const col = headerMap[header];
        if (!col) return undefined;
        const v = row.getCell(col).value;
        if (v === null || v === undefined || v === '') return undefined;
        if (v instanceof Date) return v;
        if (typeof v === 'object' && 'text' in v) return v.text;
        if (typeof v === 'object' && 'result' in v) return v.result;
        return v;
      };

      // This is one way to *add* pre-orders in bulk, not a mirror of the
      // sheet - existing rows (CRUD-added or from an earlier import) are
      // left alone. Dedup against phone + product + order date, the closest
      // thing this sheet has to a natural key, so re-importing the same or
      // an overlapping file doesn't pile up duplicates.
      const existing = await PreOrder.find({}).lean();
      const existingKeys = new Set(existing.map((p) => preOrderDedupKey(p.customerPhone, p.productName, p.orderDate)));

      const dryRun = req.query.dryRun === 'true';
      let productMapping = {};
      if (req.body.productMapping) {
        try {
          productMapping = JSON.parse(req.body.productMapping);
        } catch (e) {
          // Malformed mapping just leaves those rows unresolved below.
        }
      }
      // Whoever runs a bulk import is the attributed creator for every row it
      // adds - there's no per-row "who entered this" in the sheet itself.
      // Skipped during dryRun since nothing is actually being created yet.
      const importerCreator = dryRun ? {} : await resolvePreOrderCreator(req, {});

      // Same reasoning as the Order import above: neither an exact catalog
      // match nor an admin-picked productMapping entry carries hpp itself.
      const productHppById = new Map(
        (await Product.find({}, 'hpp').lean()).map((p) => [String(p._id), p.hpp])
      );

      // Resolved, never created here - same reasoning as POST /api/orders/
      // import: exact catalog name match first, then whatever the admin
      // chose via `productMapping` for names the dry run flagged as unknown.
      const productCache = new Map();
      const chatCache = new Map();
      const unresolvedProducts = new Set();
      let added = 0;
      let skippedDuplicate = 0;
      let rowsProductUnresolvedSkipped = 0;

      for (let r = headerRowNumber + 1; r <= worksheet.rowCount; r++) {
        const row = worksheet.getRow(r);
        const customerName = String(getCell(row, 'Nama Customer') || '').trim();
        const customerPhone = normalizePreOrderPhone(getCell(row, 'No HP/WA'));
        const productName = String(getCell(row, 'Produk') || '').trim();
        if (!customerName && !customerPhone && !productName) continue; // blank/trailing row

        const orderDateRaw = getCell(row, 'Tanggal Order');
        const orderDate = orderDateRaw instanceof Date ? orderDateRaw : undefined;

        const key = preOrderDedupKey(customerPhone, productName, orderDate);
        if (existingKeys.has(key)) {
          skippedDuplicate++;
          continue;
        }

        let resolvedProduct = null;
        if (productName) {
          if (productCache.has(productName)) {
            resolvedProduct = productCache.get(productName);
          } else {
            const exact = await Product.findOne({ name: productName }).lean();
            resolvedProduct = exact
              ? { productId: exact._id, productName: exact.name }
              : (productMapping[productName] || null);
            productCache.set(productName, resolvedProduct);
          }
        }

        if (!resolvedProduct) {
          if (productName) unresolvedProducts.add(productName);
          if (!dryRun) rowsProductUnresolvedSkipped++;
          continue;
        }

        if (dryRun) continue; // preview only - no writes below this point

        if (customerPhone && !chatCache.has(customerPhone)) {
          let chat = await Chat.findById(customerPhone);
          if (!chat) {
            chat = await Chat.create({
              _id: customerPhone,
              name: customerName,
              phone: customerPhone,
              firstMessageDate: orderDate ? orderDate.toISOString() : undefined,
              firstSeenAt: new Date().toISOString(),
            });
          }
          chatCache.set(customerPhone, chat);
        }

        const noResiRaw = String(getCell(row, 'No Resi') || '').trim();
        const noResi = noResiRaw.split(/[;,]/).map((s) => s.trim()).filter(Boolean)[0] || undefined;
        const ctt = getCell(row, 'CTT');

        await PreOrder.create({
          ...importerCreator,
          orderNumber: await getNextPreOrderNumber(),
          orderDate,
          customerName,
          customerPhone,
          address: getCell(row, 'Alamat Lengkap'),
          productName: resolvedProduct.productName,
          productId: resolvedProduct.productId,
          qty: numOrUndefined(getCell(row, 'Qty')),
          unitPrice: numOrUndefined(getCell(row, 'Harga Satuan')),
          hpp: resolvedProduct.productId ? productHppById.get(String(resolvedProduct.productId)) : undefined,
          totalPrice: numOrUndefined(getCell(row, 'Total Harga')),
          shippingCost: numOrUndefined(getCell(row, 'Ongkir')),
          totalBill: numOrUndefined(getCell(row, 'Total Tagihan')),
          paymentMethod: getCell(row, 'Metode Bayar'),
          paymentStatus: getCell(row, 'Status Bayar'),
          courier: getCell(row, 'Kurir'),
          noResi,
          statusOrder: getCell(row, 'Status Order'),
          campaignSource: getCell(row, 'Sumber Campaign'),
          note: getCell(row, 'Catatan'),
          lincah: getCell(row, 'LINCAH') === true,
          aneka: getCell(row, 'ANEKA') === true,
          ctt: ctt !== undefined ? String(ctt) : undefined,
        });
        existingKeys.add(key); // guard against duplicate rows within the same file
        added++;
      }

      if (dryRun) {
        return res.json({ dryRun: true, unresolvedProducts: Array.from(unresolvedProducts) });
      }

      res.json({ ok: true, added, skippedDuplicate, rowsProductUnresolvedSkipped });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ---- Ads (Meta Ads Manager export - spend/results per campaign per day) ----
  // Exported as CSV, not xlsx like the other imports. ID Kampanye is an
  // 18-digit number that overflows Number.MAX_SAFE_INTEGER (2^53-1) - a
  // generic CSV-to-object parser (ExcelJS's own workbook.csv.read included)
  // auto-detects it as a number and silently corrupts the last few digits,
  // which would break every campaign match/upsert keyed on it. This parser
  // keeps every field a raw string for exactly that reason - only numOrUndefined()
  // below ever converts anything to a number, and never for campaignId.
  function parseCsvText(text) {
    const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const rows = [];
    let row = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < withoutBom.length; i++) {
      const ch = withoutBom[i];
      if (inQuotes) {
        if (ch === '"') {
          if (withoutBom[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(cur); cur = '';
      } else if (ch === '\r') {
        // skip - \n below closes the row
      } else if (ch === '\n') {
        row.push(cur); cur = '';
        rows.push(row); row = [];
      } else {
        cur += ch;
      }
    }
    if (cur !== '' || row.length > 0) { row.push(cur); rows.push(row); }
    return rows;
  }

  const AD_REQUIRED_HEADERS = ['Nama kampanye', 'Tanggal', 'ID Kampanye'];

  app.post('/api/ads/import', requireAuth, upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'file is required (field name "file")' });

      const rows = parseCsvText(req.file.buffer.toString('utf8'));
      if (rows.length === 0) return res.status(400).json({ error: 'file is empty' });

      const headerMap = {};
      rows[0].forEach((h, i) => { headerMap[h.trim()] = i; });
      const missingHeaders = AD_REQUIRED_HEADERS.filter((h) => !(h in headerMap));
      if (missingHeaders.length > 0) {
        return res.status(400).json({ error: `Kolom wajib tidak ditemukan di file: ${missingHeaders.join(', ')}` });
      }
      const getCell = (row, header) => {
        const col = headerMap[header];
        if (col === undefined) return undefined;
        const v = row[col];
        return v === undefined || v === '' ? undefined : v;
      };

      const dryRun = req.query.dryRun === 'true';
      let campaignMapping = {};
      if (req.body.campaignMapping) {
        try {
          campaignMapping = JSON.parse(req.body.campaignMapping);
        } catch (e) {
          // Malformed mapping just leaves those campaigns unmapped below.
        }
      }

      // Every campaign already mapped (from a previous import/edit), plus
      // whatever this call's campaignMapping adds - a campaign only ever
      // needs to be mapped once, not re-picked on every import.
      const existingMappings = await AdCampaignMapping.find({}).lean();
      const mappingByCampaignId = new Map(existingMappings.map((m) => [m._id, { productId: m.productId, productName: m.campaignName }]));
      Object.entries(campaignMapping).forEach(([campaignId, m]) => {
        if (m && m.productId) mappingByCampaignId.set(campaignId, m);
      });

      const seenCampaigns = new Map(); // campaignId -> campaignName, for the dry-run's unmapped list
      const adBulkOps = [];
      const mappingUpsertOps = [];
      let imported = 0;

      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const campaignId = String(getCell(row, 'ID Kampanye') || '').trim();
        if (!campaignId) continue; // blank/trailing row

        const campaignName = String(getCell(row, 'Nama kampanye') || '').trim();
        const dateRaw = String(getCell(row, 'Tanggal') || '').trim();
        if (!dateRaw) continue;

        if (!mappingByCampaignId.has(campaignId)) seenCampaigns.set(campaignId, campaignName);

        if (dryRun) continue; // preview only - no writes below this point

        const mapped = mappingByCampaignId.get(campaignId);
        const productId = mapped ? mapped.productId : undefined;

        adBulkOps.push({
          updateOne: {
            filter: { _id: `${campaignId}_${dateRaw}` },
            update: {
              $set: {
                _id: `${campaignId}_${dateRaw}`,
                campaignId,
                campaignName,
                adSetName: getCell(row, 'Nama set iklan'),
                date: new Date(dateRaw),
                status: getCell(row, 'Status Penayangan'),
                reach: numOrUndefined(getCell(row, 'Jangkauan')),
                impressions: numOrUndefined(getCell(row, 'Impresi')),
                frequency: numOrUndefined(getCell(row, 'Frekuensi')),
                resultType: getCell(row, 'Jenis hasil'),
                results: numOrUndefined(getCell(row, 'Hasil')),
                spend: numOrUndefined(getCell(row, 'Jumlah yang dibelanjakan (IDR)')),
                costPerResult: numOrUndefined(getCell(row, 'Biaya per hasil')),
                startDate: getCell(row, 'Mulai') ? new Date(getCell(row, 'Mulai')) : undefined,
                endDate: getCell(row, 'Berakhir'),
                productId,
              },
            },
            upsert: true,
          },
        });
        imported++;
      }

      if (dryRun) {
        const unmappedCampaigns = Array.from(seenCampaigns.entries()).map(([campaignId, campaignName]) => ({ campaignId, campaignName }));
        return res.json({ dryRun: true, unmappedCampaigns });
      }

      // Remember any newly-picked mappings for next time, keyed by campaignId
      // - see the schema comment on AdCampaignMapping for why. campaignName
      // comes from the client's payload (it already has it from the dry
      // run's unmappedCampaigns list) rather than `seenCampaigns` here - by
      // this point campaignMapping has already been merged into
      // mappingByCampaignId above, so a freshly-mapped campaign's rows are
      // treated as "already mapped" during the loop and never added to
      // `seenCampaigns` at all.
      Object.entries(campaignMapping).forEach(([campaignId, m]) => {
        if (!m || !m.productId) return;
        mappingUpsertOps.push({
          updateOne: {
            filter: { _id: campaignId },
            update: { $set: { _id: campaignId, campaignName: m.campaignName, productId: m.productId } },
            upsert: true,
          },
        });
      });

      if (mappingUpsertOps.length > 0) await AdCampaignMapping.bulkWrite(mappingUpsertOps);
      if (adBulkOps.length > 0) await AdSpend.bulkWrite(adBulkOps);

      res.json({ ok: true, imported });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.get('/api/ads', requireAuth, async (req, res) => {
    try {
      const docs = await AdSpend.find({}).sort({ date: -1 }).lean();
      const ads = docs.map(({ _id, __v, ...rest }) => ({ id: _id, ...rest }));
      res.json({ ads });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.delete('/api/ads/:id', requireAuth, async (req, res) => {
    try {
      await AdSpend.findByIdAndDelete(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.post('/api/ads/delete', requireAuth, async (req, res) => {
    try {
      const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
      await AdSpend.deleteMany({ _id: { $in: ids } });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Every distinct campaign seen in AdSpend, joined with its mapping (if
  // any) - drives the Iklan page's "Mapping Kampanye ke Produk" panel, which
  // needs to show campaigns with no product picked yet too, not just mapped ones.
  app.get('/api/ads/campaigns', requireAuth, async (req, res) => {
    try {
      const [mappings, distinctCampaigns] = await Promise.all([
        AdCampaignMapping.find({}).lean(),
        AdSpend.aggregate([{ $group: { _id: '$campaignId', campaignName: { $last: '$campaignName' } } }]),
      ]);
      const mappingById = new Map(mappings.map((m) => [m._id, m]));
      const campaigns = distinctCampaigns.map((c) => {
        const mapping = mappingById.get(c._id);
        return {
          campaignId: c._id,
          campaignName: mapping ? mapping.campaignName : c.campaignName,
          productId: mapping ? mapping.productId : undefined,
        };
      });
      res.json({ campaigns });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Sets/changes/clears one campaign's product link - applies retroactively
  // to every AdSpend row already imported for it, not just future imports,
  // so correcting a wrong mapping doesn't leave old rows pointing the old way.
  app.put('/api/ads/campaigns/:campaignId', requireAuth, async (req, res) => {
    try {
      const { productId, campaignName } = req.body || {};
      const campaignId = req.params.campaignId;
      if (productId) {
        await AdCampaignMapping.findByIdAndUpdate(
          campaignId,
          { $set: { _id: campaignId, campaignName, productId } },
          { upsert: true }
        );
        await AdSpend.updateMany({ campaignId }, { $set: { productId } });
      } else {
        await AdCampaignMapping.findByIdAndDelete(campaignId);
        await AdSpend.updateMany({ campaignId }, { $unset: { productId: '' } });
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Removes a campaign entirely - the mapping AND every AdSpend row ever
  // imported for it, not just the product link (PUT above, with no
  // productId, only clears that). For getting rid of test/duplicate
  // campaigns from the mapping panel instead of leaving them unmapped forever.
  app.delete('/api/ads/campaigns/:campaignId', requireAuth, async (req, res) => {
    try {
      const campaignId = req.params.campaignId;
      await Promise.all([
        AdCampaignMapping.findByIdAndDelete(campaignId),
        AdSpend.deleteMany({ campaignId }),
      ]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ---- Tracked phones (presence check for the extension's chat-list badge) ----
  // Just the distinct phones that have ANY Order or PreOrder record at all,
  // regardless of status/converted - unlike the filtered read-only mirrors
  // above (active Pra-Pesanan, orders awaiting a resi notify), which are
  // scoped to "something actionable right now". This is specifically "has
  // this contact ever been entered into Pesanan/Pra-Pesanan", so a Closing
  // chat with neither can be flagged "Belum Di Input" instead of being
  // lumped in with "Belum Dikabari" (which implies it *is* tracked, just not
  // notified yet).
  app.get('/api/tracked-phones', requireAuth, async (req, res) => {
    try {
      const [orderPhones, preOrderPhones] = await Promise.all([
        Order.distinct('customerPhone'),
        PreOrder.distinct('customerPhone'),
      ]);
      const phones = Array.from(new Set([...orderPhones, ...preOrderPhones].filter(Boolean)));
      res.json({ phones });
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

  // ---- Dashboard (aggregated stats for the management-facing Dashboard page) ----
  //
  // One endpoint, computed server-side in a single pass over Chat/Order/
  // PreOrder, rather than shipping all three collections to the browser just
  // to sum/group them there (the rest of this app does client-side
  // aggregation over already-small tables; Dashboard's numbers span the
  // whole business, so they're computed here instead).
  //
  // Query params (all optional): `from`/`to` (YYYY-MM-DD, inclusive),
  // `ownerNumber`, `productName`, `createdByEmail` - 'all' or omitted means
  // no filter on that dimension. `productName` may repeat
  // (?productName=A&productName=B) to select multiple products at once.
  // ownerNumber only affects Chat/Order metrics (PreOrder has no owner
  // concept, it's tied to a CS creator instead); createdByEmail only
  // affects PreOrder metrics for the same reason.

  // ---- Laporan (report page - Total Omset + Total Biaya Iklan side by
  // side, same filter shape as Dashboard) ----
  // Deliberately its own lightweight endpoint rather than reusing
  // /api/dashboard/stats - that one aggregates Chat/Order/PreOrder for a
  // dozen unrelated cards/charts; this page only needs two numbers plus the
  // filter dropdown options, so it only fetches what those actually need.
  app.get('/api/laporan/stats', requireAuth, async (req, res) => {
    try {
      const { from, to } = req.query;
      // 'order' (default) filters orders by their own createdDate ("Tanggal
      // Dibuat" from the COD platform export); 'lead' filters by the first
      // time the customer's chat came in instead (Chat.firstMessageDate),
      // via the same customerPhone <-> Chat._id link the order-import route
      // already uses to create/match a Chat for each order. Useful for
      // seeing revenue by when the lead originated rather than when the
      // order was placed - a lead from June that only converted in July
      // shows up under June with this basis, not July.
      const dateBasis = req.query.dateBasis === 'lead' ? 'lead' : 'order';
      const ownerNumber = req.query.ownerNumber && req.query.ownerNumber !== 'all' ? req.query.ownerNumber : null;
      const productNames = (Array.isArray(req.query.productName) ? req.query.productName : req.query.productName ? [req.query.productName] : [])
        .filter((p) => p && p !== 'all');
      // createdByEmail (CS) is accepted for filter-bar consistency with
      // Dashboard, but - same as there - Order has no CS/creator field, so
      // it can't narrow Total Omset; and AdSpend has no CS concept either.
      // Neither card in this report can honor it.

      const fromTime = from ? new Date(`${from}T00:00:00`).getTime() : null;
      const toTime = to ? new Date(`${to}T00:00:00`).getTime() + 24 * 60 * 60 * 1000 - 1 : null;
      const withinDateFilter = (dateValue) => {
        if (fromTime === null && toTime === null) return true;
        if (!dateValue) return false;
        const t = new Date(dateValue).getTime();
        if (fromTime !== null && t < fromTime) return false;
        if (toTime !== null && t > toTime) return false;
        return true;
      };

      const [chats, orders, preOrders, products, adSpends] = await Promise.all([
        Chat.find({}).lean(),
        Order.find({}).lean(),
        PreOrder.find({}).lean(),
        Product.find({}).lean(),
        AdSpend.find({}).lean(),
      ]);

      // Chat._id is the same phone digits as Order.customerPhone - the order
      // import route creates/matches a Chat by that exact value - so this
      // lookup needs no extra normalization.
      const chatByPhone = new Map(chats.map((c) => [c._id, c]));
      const orderDateForFilter = (o) =>
        dateBasis === 'lead' ? chatByPhone.get(o.customerPhone)?.firstMessageDate : o.createdDate;

      const filteredOrders = orders.filter((o) =>
        (!ownerNumber || (o.ownerNumber || '') === ownerNumber) &&
        (productNames.length === 0 || productNames.includes(o.productName || '')) &&
        withinDateFilter(orderDateForFilter(o))
      );
      // Same formula as the Dashboard/Pesanan Omset cards - Nilai COD minus
      // Ongkos Kirim minus Biaya COD, excluding cancelled orders.
      const orderRealPrice = (o) => (o.codValue || 0) - (o.shippingCost || 0) - (o.codFee || 0);
      const totalOmset = filteredOrders
        .filter((o) => o.status !== 'Dibatalkan')
        .reduce((sum, o) => sum + orderRealPrice(o), 0);
      // Same scope as Total Omset (every non-cancelled order, Return
      // included - the cost of goods is real even for a returned item).
      const totalHpp = filteredOrders
        .filter((o) => o.status !== 'Dibatalkan')
        .reduce((sum, o) => sum + (o.hpp || 0) * (o.qty || 1), 0);

      // AdSpend has no ownerNumber of its own - only date and product (via
      // the campaign->product mapping already stamped onto each row) apply.
      // Also always filtered by its own a.date regardless of dateBasis - it's
      // a campaign-level daily spend row, not tied to any single customer/
      // lead, so "tanggal lead" has no equivalent meaning for it.
      const productIdsByName = new Set(
        productNames.length > 0
          ? products.filter((p) => productNames.includes(p.name)).map((p) => String(p._id))
          : []
      );
      const filteredAdSpends = adSpends.filter((a) =>
        (productNames.length === 0 || (a.productId && productIdsByName.has(String(a.productId)))) &&
        withinDateFilter(a.date)
      );
      const totalBiayaIklan = filteredAdSpends.reduce((sum, a) => sum + (a.spend || 0), 0);

      // Profit = Omset - HPP - Biaya Iklan, but NOT a naive
      // totalOmset - totalHpp - totalBiayaIklan - that would overstate
      // Return orders, whose Nilai COD totalOmset still counts even though
      // the COD was never actually collected (the item came back). Same
      // per-order rule as Dashboard's Total Profit: Return is a full loss
      // (Ongkir + HPP, no omset at all), Dibatalkan is ignored entirely,
      // everything else is orderRealPrice minus HPP x Qty - THEN ad spend
      // is subtracted once on top, since it's a campaign-level cost, not
      // a per-order one.
      const profitFromOrders = filteredOrders.reduce((sum, o) => {
        if (o.status === 'Dibatalkan') return sum;
        const hppCost = (o.hpp || 0) * (o.qty || 1);
        if (o.status === 'Return') return sum - ((o.shippingCost || 0) + hppCost);
        return sum + (orderRealPrice(o) - hppCost);
      }, 0);
      const totalProfit = profitFromOrders - totalBiayaIklan;

      // Profit Terealisasi - same definition as Dashboard's own realized
      // profit card: only orders that are Diterima AND already
      // rekonsiliasi (the only bucket that's confirmed money, not a
      // projection) - then Biaya Iklan is subtracted here too, same as
      // the all-orders Profit above, since ad spend already happened
      // regardless of which orders have finished shipping yet.
      const realizedProfitFromOrders = filteredOrders.reduce((sum, o) => {
        if (o.status !== 'Diterima' || o.reconciliationStatus !== 'Sudah Rekonsiliasi') return sum;
        const hppCost = (o.hpp || 0) * (o.qty || 1);
        return sum + (orderRealPrice(o) - hppCost);
      }, 0);
      const realizedProfit = realizedProfitFromOrders - totalBiayaIklan;

      // ---- Per-provinsi return rate + problem rate (Order.province -
      // "Provinsi" penerima dari file impor Pesanan), dari filteredOrders
      // yang sama (ikut filter owner/produk/tanggal di atas), jadi konsisten
      // dengan card-card lain di halaman ini.
      const provinceMap = new Map();
      filteredOrders.forEach((o) => {
        const province = o.province || '(Tidak Diketahui)';
        const entry = provinceMap.get(province) || { province, count: 0, returnCount: 0, problemCount: 0, successCount: 0 };
        entry.count += 1;
        if (o.status === 'Return') entry.returnCount += 1;
        if (isProblematicOrder(o)) entry.problemCount += 1;
        // "Sukses" = sudah Diterima - same status the Dashboard funnel's own
        // deliveredCount uses, the only status that's an unambiguous finished
        // success (Dalam Pengiriman/Menunggu Dijemput are still in flight,
        // Return/Dibatalkan are the opposite of success).
        if (o.status === 'Diterima') entry.successCount += 1;
        provinceMap.set(province, entry);
      });
      const returnRateByProvince = Array.from(provinceMap.values())
        .map((e) => ({
          province: e.province,
          total: e.count,
          returnCount: e.returnCount,
          rate: e.count > 0 ? Math.round((e.returnCount / e.count) * 1000) / 10 : 0,
          problemCount: e.problemCount,
          problemRate: e.count > 0 ? Math.round((e.problemCount / e.count) * 1000) / 10 : 0,
          successCount: e.successCount,
          successRate: e.count > 0 ? Math.round((e.successCount / e.count) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.rate - a.rate);

      // ---- Per-produk breakdown (Total Pesanan/Omset/HPP/Profit/Profit
      // Terealisasi per product, same filteredOrders as the cards above so
      // summing every row here reproduces the overall cards exactly).
      // Biaya Iklan per product comes from filteredAdSpends grouped via
      // AdSpend.productId -> Product.name (an ad row with no product mapping
      // yet has nothing to attribute to and is left out of every product's
      // row, same as it's excluded from the overall totalBiayaIklan whenever
      // a product filter is active).
      const productNameById = new Map(products.map((p) => [String(p._id), p.name]));

      // Paired "*Count" fields alongside each money figure below - how many
      // orders that Rupiah amount was actually summed from, so the table can
      // show it right under the number (a product with a huge Omset from 2
      // orders reads very differently than the same Omset from 40). Each
      // count mirrors the exact same row filter as the money field next to
      // it, not just the overall totalPesanan: omsetCount for Omset/HPP/
      // Profit (all share the same "not Dibatalkan" condition), realizedCount
      // for Profit Terealisasi/Omset Diterima, returnCount for Omset Return/
      // Biaya Retur, problematicCount for Potensi RTS. Biaya Iklan has no
      // equivalent - it's ad spend aggregated from AdSpend rows, not summed
      // per order - so it's deliberately left without a count.
      const orderStatsByProduct = new Map();
      filteredOrders.forEach((o) => {
        const name = o.productName || '(Tanpa Produk)';
        const entry = orderStatsByProduct.get(name) || {
          totalPesanan: 0, omset: 0, hpp: 0, profitFromOrders: 0, realizedProfitFromOrders: 0,
          omsetDiterima: 0, omsetReturn: 0, biayaRetur: 0, potensiRTS: 0,
          omsetCount: 0, realizedCount: 0, returnCount: 0, problematicCount: 0,
        };
        entry.totalPesanan += 1;
        if (o.status !== 'Dibatalkan') {
          const hppCost = (o.hpp || 0) * (o.qty || 1);
          entry.omset += orderRealPrice(o);
          entry.hpp += hppCost;
          entry.profitFromOrders += o.status === 'Return' ? -((o.shippingCost || 0) + hppCost) : (orderRealPrice(o) - hppCost);
          entry.omsetCount += 1;
          if (o.status === 'Diterima' && o.reconciliationStatus === 'Sudah Rekonsiliasi') {
            entry.realizedProfitFromOrders += orderRealPrice(o) - hppCost;
            entry.omsetDiterima += orderRealPrice(o);
            entry.realizedCount += 1;
          }
          if (o.status === 'Return') {
            // Same shape as Omset for every other status (orderRealPrice,
            // Return included) - see totalOmset above, which already counts
            // Return orders the same way.
            entry.omsetReturn += orderRealPrice(o);
            // Same formula as the Dashboard's "Ongkir Return (Invoice)" card
            // (ongkirReturnInvoice below) - the actual return-leg shipping
            // invoice, using the real ongkirPulang from a Problem Tracking
            // import when available, falling back to shippingCost (the
            // outbound leg) as a same-rate estimate otherwise. Deliberately
            // NOT the "Kerugian Return" (Ongkir + HPP) formula - that's a
            // different card with a different question (total loss on the
            // order) than this one (just the shipping invoice).
            entry.biayaRetur += o.ongkirPulang ?? o.shippingCost ?? 0;
            entry.returnCount += 1;
          }
        }
        if (isProblematicOrder(o)) {
          entry.potensiRTS += o.potensiRTS || 0;
          entry.problematicCount += 1;
        }
        orderStatsByProduct.set(name, entry);
      });
      const adSpendByProduct = new Map();
      filteredAdSpends.forEach((a) => {
        // Bucket under the same '(Tanpa Produk)' label as orders with no
        // productName, rather than dropping the row - a campaign not yet
        // mapped to a product still counts toward the overall totalBiayaIklan
        // card above, so silently excluding it here would make this table's
        // Biaya Iklan column never add up to that card.
        const name = (a.productId && productNameById.get(String(a.productId))) || '(Tanpa Produk)';
        adSpendByProduct.set(name, (adSpendByProduct.get(name) || 0) + (a.spend || 0));
      });
      const allProductNames = new Set([...orderStatsByProduct.keys(), ...adSpendByProduct.keys()]);
      const productBreakdown = Array.from(allProductNames)
        .map((name) => {
          const stats = orderStatsByProduct.get(name) || {
            totalPesanan: 0, omset: 0, hpp: 0, profitFromOrders: 0, realizedProfitFromOrders: 0,
            omsetDiterima: 0, omsetReturn: 0, biayaRetur: 0, potensiRTS: 0,
            omsetCount: 0, realizedCount: 0, returnCount: 0, problematicCount: 0,
          };
          const biayaIklan = adSpendByProduct.get(name) || 0;
          return {
            productName: name,
            totalPesanan: stats.totalPesanan,
            omset: stats.omset,
            biayaIklan,
            hpp: stats.hpp,
            profit: stats.profitFromOrders - biayaIklan,
            realizedProfit: stats.realizedProfitFromOrders - biayaIklan,
            // Profit Diterima: order-level profit (Omset Diterima - HPP) of
            // just the Diterima + Sudah Rekonsiliasi orders, WITHOUT
            // subtracting Biaya Iklan - the order-only counterpart to Omset
            // Diterima, same way Profit is Omset's order-only counterpart.
            // Deliberately distinct from Profit Terealisasi (realizedProfit
            // above), which is this same figure minus Biaya Iklan - Biaya
            // Iklan is a campaign-level cost, not tied to any one order, so
            // this column isolates what the delivered orders themselves
            // actually made before that campaign cost is netted out.
            profitDiterima: stats.realizedProfitFromOrders,
            omsetDiterima: stats.omsetDiterima,
            omsetReturn: stats.omsetReturn,
            biayaRetur: stats.biayaRetur,
            potensiRTS: stats.potensiRTS,
            // See the comment above orderStatsByProduct's declaration for
            // what each of these actually counts.
            omsetCount: stats.omsetCount,
            realizedCount: stats.realizedCount,
            returnCount: stats.returnCount,
            problematicCount: stats.problematicCount,
          };
        })
        .sort((a, b) => b.omset - a.omset);

      // Product options deliberately exclude Chat.product - that field is a
      // free-text label set per-chat from the extension and drifts from the
      // Product master (renamed/discontinued products, typos), which polluted
      // this filter with names that never appear in an actual Order/PreOrder.
      // Owners still come from Chat since Order/PreOrder don't always carry
      // ownerNumber consistently.
      const filterOptions = {
        owners: Array.from(new Set(chats.map((c) => c.ownerNumber).filter(Boolean))).sort(),
        products: Array.from(new Set([
          ...orders.map((o) => o.productName),
          ...preOrders.map((p) => p.productName),
        ].filter(Boolean))).sort(),
        creators: Array.from(new Set(preOrders.map((p) => p.createdByEmail).filter(Boolean))).sort(),
      };

      res.json({
        cards: { totalOmset, totalHpp, totalBiayaIklan, totalProfit, realizedProfit },
        returnRateByProvince,
        productBreakdown,
        filterOptions,
      });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
    try {
      const { from, to } = req.query;
      const ownerNumber = req.query.ownerNumber && req.query.ownerNumber !== 'all' ? req.query.ownerNumber : null;
      // productName may be repeated (?productName=A&productName=B) for a
      // multi-select filter - normalize to an array regardless of how many
      // values came in; an empty array means "no product filter".
      const productNames = (Array.isArray(req.query.productName) ? req.query.productName : req.query.productName ? [req.query.productName] : [])
        .filter((p) => p && p !== 'all');
      const createdByEmail = req.query.createdByEmail && req.query.createdByEmail !== 'all' ? req.query.createdByEmail : null;
      // Same 'order'/'lead' toggle as Laporan - see the comment there. Only
      // affects Order (createdDate) and PreOrder (orderDate), which each have
      // a native date of their own to switch away from; a Chat/lead itself
      // has no separate "order date" to toggle, so chatMasuk/closingRate
      // below always stay on firstMessageDate regardless of this setting.
      const dateBasis = req.query.dateBasis === 'lead' ? 'lead' : 'order';

      const fromTime = from ? new Date(`${from}T00:00:00`).getTime() : null;
      const toTime = to ? new Date(`${to}T00:00:00`).getTime() + 24 * 60 * 60 * 1000 - 1 : null;
      const withinDateFilter = (dateValue) => {
        if (fromTime === null && toTime === null) return true;
        if (!dateValue) return false;
        const t = new Date(dateValue).getTime();
        if (fromTime !== null && t < fromTime) return false;
        if (toTime !== null && t > toTime) return false;
        return true;
      };

      const [chats, orders, preOrders, settingsDoc] = await Promise.all([
        Chat.find({}).lean(),
        Order.find({}).lean(),
        PreOrder.find({}).lean(), // includes converted ones - needed for the funnel/CS history
        Settings.findById('singleton').lean(),
      ]);
      const chatByPhone = new Map(chats.map((c) => [c._id, c]));
      const orderDateForFilter = (o) => (dateBasis === 'lead' ? leadDateForPhone(o.customerPhone, chatByPhone) : o.createdDate);
      const preOrderDateForFilter = (p) => (dateBasis === 'lead' ? leadDateForPhone(p.customerPhone, chatByPhone) : p.orderDate);
      const settings = settingsDoc || { closingLabels: [], manualClosing: {} };

      // Mirrors the client's isClosing() in dashboard.js exactly - same rule,
      // computed here since Dashboard aggregates across the whole business.
      const isClosingChat = (chat) => {
        const byLabel = (chat.labels || []).some((l) => (settings.closingLabels || []).includes(l));
        const manual = chat.manualClosing === true || (settings.manualClosing && settings.manualClosing[chat._id] === true);
        return byLabel || manual;
      };

      const filteredChats = chats.filter((c) =>
        (!ownerNumber || (c.ownerNumber || '') === ownerNumber) &&
        (productNames.length === 0 || productNames.includes(c.product || '')) &&
        withinDateFilter(c.firstMessageDate)
      );
      const filteredOrders = orders.filter((o) =>
        (!ownerNumber || (o.ownerNumber || '') === ownerNumber) &&
        (productNames.length === 0 || productNames.includes(o.productName || '')) &&
        withinDateFilter(orderDateForFilter(o))
      );
      const filteredPreOrders = preOrders.filter((p) =>
        (productNames.length === 0 || productNames.includes(p.productName || '')) &&
        (!createdByEmail || (p.createdByEmail || '') === createdByEmail) &&
        withinDateFilter(preOrderDateForFilter(p))
      );

      // ---- Cards ----
      const chatMasuk = filteredChats.length;
      const closingCount = filteredChats.filter(isClosingChat).length;
      const closingRate = chatMasuk > 0 ? Math.round((closingCount / chatMasuk) * 1000) / 10 : 0;

      // Harga riil per order = Nilai COD dikurangi Ongkos Kirim dan Biaya COD
      // (bukan field price mentah), sama seperti kolom Harga di halaman Pesanan.
      const orderRealPrice = (o) => (o.codValue || 0) - (o.shippingCost || 0) - (o.codFee || 0);

      const nonCancelledOrders = filteredOrders.filter((o) => o.status !== 'Dibatalkan');
      const cancelledCount = filteredOrders.filter((o) => o.status === 'Dibatalkan').length;
      const deliveredCount = filteredOrders.filter((o) => o.status === 'Diterima').length;
      const totalOmset = nonCancelledOrders.reduce((sum, o) => sum + orderRealPrice(o), 0);
      const totalOngkir = nonCancelledOrders.reduce((sum, o) => sum + (o.shippingCost || 0), 0);
      const totalBiayaCod = nonCancelledOrders.reduce((sum, o) => sum + (o.codFee || 0), 0);
      const totalPesanan = filteredOrders.length;

      // ---- Paket bermasalah (Order.problem - catatan kendala dari kurir,
      // mis. "NOBODY AT HOME", "CONSIGNEE REFUSE TO PAY COD", diisi lewat
      // impor xlsx Pesanan) ---- see isProblematicOrder() above for the rule.
      const problematicOrders = filteredOrders.filter(isProblematicOrder);
      const problematicOrderCount = problematicOrders.length;
      const problematicOrderOmset = problematicOrders.reduce((sum, o) => sum + orderRealPrice(o), 0);
      // Only populated for orders that have gone through the separate
      // "problem tracking" import (POST /api/orders/import-problem-tracking)
      // - orders whose problem note came only from the main Pesanan import
      // contribute 0 here since there's no ongkir breakdown for them yet.
      const problematicOrderPotensiRTS = problematicOrders.reduce((sum, o) => sum + (o.potensiRTS || 0), 0);

      // ---- Ongkir Dihemat / Ongkir Return (Invoice) ----
      // Two deliberately separate numbers (validated against lincah's own
      // dashboard, which shows the same split) - never net them into one
      // "Total Ongkir Dihemat" figure here, since that hides which half is
      // money already sitting safely in Saldo (Dihemat) vs money that
      // actually got billed and deducted from that same Saldo (Return).
      //
      // Ongkos Kirim Dihemat: originalShippingCost (tarif normal) minus
      // shippingCost (tarif borongan lincah, what's actually deducted from
      // Nilai COD) on every non-cancelled order - the running total of
      // "you paid less than list price" that's already baked into every
      // order's own Omset above, not extra money on top of it.
      const ongkirDihemat = nonCancelledOrders.reduce(
        (sum, o) => sum + ((o.originalShippingCost || 0) - (o.shippingCost || 0)), 0
      );
      // Ongkos Kirim Return (Invoice): the return-leg shipping cost billed
      // once a package comes back - uses the real ongkirPulang from a
      // Problem Tracking import when available (see
      // POST /api/orders/import-problem-tracking), falling back to
      // shippingCost (the outbound leg) as a same-rate estimate for Return
      // orders that never went through that import - validated against a
      // real lincah invoice where this fallback landed exactly on their
      // reported figure.
      const ongkirReturnInvoice = filteredOrders
        .filter((o) => o.status === 'Return')
        .reduce((sum, o) => sum + (o.ongkirPulang ?? o.shippingCost ?? 0), 0);

      // Omset + jumlah pesanan per status - satu card per status di dashboard.
      // "Diterima" dipecah jadi dua label: yang sudah direkonsiliasi tetap
      // "Diterima", yang belum jadi "Menunggu Rekonsiliasi" - supaya omset
      // yang statusnya belum final terlihat terpisah dari yang sudah pasti.
      const statusBuckets = new Map();
      filteredOrders.forEach((o) => {
        let label = o.status || '(Tanpa Status)';
        if (label === 'Diterima' && o.reconciliationStatus !== 'Sudah Rekonsiliasi') {
          label = 'Menunggu Rekonsiliasi';
        }
        const entry = statusBuckets.get(label) || { label, omset: 0, count: 0 };
        entry.omset += orderRealPrice(o);
        entry.count += 1;
        statusBuckets.set(label, entry);
      });
      const omsetByStatus = Array.from(statusBuckets.values()).sort((a, b) => b.count - a.count);

      // Profit per status - beda perlakuan tergantung status:
      // - Diterima/Dalam Pengiriman/Menunggu Dijemput/Menunggu Rekonsiliasi:
      //   profit normal = omset (orderRealPrice) dikurangi HPP x Qty.
      // - Return: sesuai ketentuan bisnis, barang return dianggap rusak/tidak
      //   bisa dijual lagi - jadi rugi PENUH sebesar Ongkos Kirim + HPP x Qty,
      //   tanpa omset sama sekali (uang COD-nya memang tidak pernah cair).
      // - Dibatalkan: diabaikan total dari perhitungan profit (tidak untung
      //   tidak rugi) - beda dari status lain yang tetap dihitung meski cuma
      //   proyeksi (Dalam Pengiriman dkk).
      const profitBuckets = new Map();
      filteredOrders.forEach((o) => {
        if (o.status === 'Dibatalkan') return;
        let label = o.status || '(Tanpa Status)';
        if (label === 'Diterima' && o.reconciliationStatus !== 'Sudah Rekonsiliasi') {
          label = 'Menunggu Rekonsiliasi';
        }
        const hppCost = (o.hpp || 0) * (o.qty || 1);
        const profit = label === 'Return'
          ? -((o.shippingCost || 0) + hppCost)
          : orderRealPrice(o) - hppCost;
        const entry = profitBuckets.get(label) || { label, profit: 0, count: 0 };
        entry.profit += profit;
        entry.count += 1;
        profitBuckets.set(label, entry);
      });
      const profitByStatus = Array.from(profitBuckets.values()).sort((a, b) => b.count - a.count);
      const totalProfit = profitByStatus.reduce((sum, s) => sum + s.profit, 0);

      // The 4 profit categories discussed with the owner:
      // - Profit Kotor (Gross): every status that isn't a Return loss,
      //   whether the money's already in hand or still in transit.
      // - Profit Terealisasi (Realized): Diterima only - the only bucket
      //   that's actually confirmed money, not a projection.
      // - Profit Berjalan (Projected/In-transit): everything gross minus
      //   what's already realized - still "in flight", not yet final.
      // - Kerugian Return (Loss): the Return bucket on its own, always <= 0.
      // totalProfit above = grossProfit + returnLoss = realizedProfit +
      // projectedProfit + returnLoss - same bottom line, three different cuts.
      const findBucket = (label) => (profitByStatus.find((b) => b.label === label) || { profit: 0 }).profit;
      const returnLoss = findBucket('Return');
      const grossProfit = totalProfit - returnLoss;
      const realizedProfit = findBucket('Diterima');
      const projectedProfit = grossProfit - realizedProfit;

      const avgOrderValue = nonCancelledOrders.length > 0 ? Math.round(totalOmset / nonCancelledOrders.length) : 0;
      const cancellationRate = totalPesanan > 0 ? Math.round((cancelledCount / totalPesanan) * 1000) / 10 : 0;

      const activePreOrders = filteredPreOrders.filter((p) => !p.convertedOrderId).length;

      // ---- Revenue by day (line chart) ----
      const revenueByDayMap = new Map();
      nonCancelledOrders.forEach((o) => {
        const orderDate = orderDateForFilter(o);
        if (!orderDate) return;
        const day = new Date(orderDate).toISOString().slice(0, 10);
        revenueByDayMap.set(day, (revenueByDayMap.get(day) || 0) + orderRealPrice(o));
      });
      const revenueByDay = Array.from(revenueByDayMap.entries())
        .map(([date, omset]) => ({ date, omset }))
        .sort((a, b) => a.date.localeCompare(b.date));

      // ---- Chats by day (lead volume trend line chart) ----
      const chatsByDayMap = new Map();
      filteredChats.forEach((c) => {
        if (!c.firstMessageDate) return;
        const day = new Date(c.firstMessageDate).toISOString().slice(0, 10);
        chatsByDayMap.set(day, (chatsByDayMap.get(day) || 0) + 1);
      });
      const chatsByDay = Array.from(chatsByDayMap.entries())
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date));

      // ---- Orders by product (bar chart) ----
      const productMap = new Map();
      nonCancelledOrders.forEach((o) => {
        const name = o.productName || '(Tanpa Nama)';
        const entry = productMap.get(name) || { productName: name, omset: 0, qty: 0 };
        entry.omset += orderRealPrice(o);
        entry.qty += o.qty || 1;
        productMap.set(name, entry);
      });
      const ordersByProduct = Array.from(productMap.values()).sort((a, b) => b.omset - a.omset);

      // ---- Pre-orders by CS (bar chart) - all of them, active+converted,
      // since this is about CS productivity, not just what's still pending ----
      const creatorMap = new Map();
      filteredPreOrders.forEach((p) => {
        const email = p.createdByEmail || '(Tidak diketahui)';
        creatorMap.set(email, (creatorMap.get(email) || 0) + 1);
      });
      const preOrdersByCreator = Array.from(creatorMap.entries())
        .map(([email, count]) => ({ email, count }))
        .sort((a, b) => b.count - a.count);

      // ---- Closing rate by Akun WA (bar chart) ----
      const ownerMap = new Map();
      filteredChats.forEach((c) => {
        const owner = c.ownerNumber || '(Tanpa Akun)';
        const entry = ownerMap.get(owner) || { ownerNumber: owner, total: 0, closing: 0 };
        entry.total += 1;
        if (isClosingChat(c)) entry.closing += 1;
        ownerMap.set(owner, entry);
      });
      const closingRateByOwner = Array.from(ownerMap.values())
        .map((e) => ({
          ownerNumber: e.ownerNumber,
          total: e.total,
          closing: e.closing,
          rate: e.total > 0 ? Math.round((e.closing / e.total) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.total - a.total);

      // ---- Leads vs Orders by product (which products get asked about a
      // lot but don't convert, vs the reverse) ----
      const leadsByProductMap = new Map();
      filteredChats.forEach((c) => {
        if (!c.product) return;
        leadsByProductMap.set(c.product, (leadsByProductMap.get(c.product) || 0) + 1);
      });
      const orderCountByProductMap = new Map();
      filteredOrders.forEach((o) => {
        if (!o.productName) return;
        orderCountByProductMap.set(o.productName, (orderCountByProductMap.get(o.productName) || 0) + 1);
      });
      const allProductNames = new Set([...leadsByProductMap.keys(), ...orderCountByProductMap.keys()]);
      const leadsVsOrdersByProduct = Array.from(allProductNames)
        .map((name) => {
          const leads = leadsByProductMap.get(name) || 0;
          const ordersCount = orderCountByProductMap.get(name) || 0;
          // Chat.product is a manual per-lead tag (new, low coverage so far),
          // while Order.productName is populated for every order - so orders
          // can outnumber "leads" for a product whose buyers mostly weren't
          // tagged in WA Web yet. A rate above 100% isn't a real conversion
          // rate, it's a coverage artifact - suppress it rather than show a
          // number that would mislead a reader taking it at face value.
          const conversionRate = leads > 0 && ordersCount <= leads
            ? Math.round((ordersCount / leads) * 1000) / 10
            : null;
          return { productName: name, leads, orders: ordersCount, conversionRate };
        })
        .sort((a, b) => b.leads - a.leads);

      // How much of the lead volume even has a product tag - context for
      // reading leadsVsOrdersByProduct, since it only covers tagged chats.
      const taggedChatCount = filteredChats.filter((c) => c.product).length;
      const productTaggingCoverage = chatMasuk > 0 ? Math.round((taggedChatCount / chatMasuk) * 1000) / 10 : 0;

      // ---- Funnel ----
      // Indicative, not a strict same-cohort funnel - a lead, a pre-order,
      // and an order aren't guaranteed to be the exact same population (an
      // order/pre-order can create a brand new contact that was never a WA
      // lead at all), so stage-to-stage "conversion" here is directional.
      const funnel = {
        leads: chatMasuk,
        preOrders: filteredPreOrders.length,
        orders: totalPesanan,
        delivered: deliveredCount,
      };

      // ---- Filter dropdown options - from the *unfiltered* full data, so
      // the dropdowns always show every possibility regardless of the
      // current selection ----
      const filterOptions = {
        owners: Array.from(new Set(chats.map((c) => c.ownerNumber).filter(Boolean))).sort(),
        products: Array.from(new Set([
          ...chats.map((c) => c.product),
          ...orders.map((o) => o.productName),
          ...preOrders.map((p) => p.productName),
        ].filter(Boolean))).sort(),
        creators: Array.from(new Set(preOrders.map((p) => p.createdByEmail).filter(Boolean))).sort(),
      };

      res.json({
        cards: {
          totalOmset, totalOngkir, totalBiayaCod, totalProfit,
          grossProfit, realizedProfit, projectedProfit, returnLoss,
          totalPesanan, avgOrderValue, cancellationRate,
          activePreOrders, chatMasuk, closingCount, closingRate,
          problematicOrderCount, problematicOrderOmset, problematicOrderPotensiRTS,
          ongkirDihemat, ongkirReturnInvoice,
        },
        omsetByStatus,
        profitByStatus,
        revenueByDay,
        chatsByDay,
        ordersByProduct,
        preOrdersByCreator,
        closingRateByOwner,
        leadsVsOrdersByProduct,
        productTaggingCoverage,
        funnel,
        filterOptions,
      });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  return app;
}

module.exports = { createApp };
