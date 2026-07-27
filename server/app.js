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
    const { _id, name, price, weight, volume, length, width, height } = doc;
    return { id: _id, name, price, weight, volume, length, width, height };
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
      const { name, price } = req.body || {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name is required' });
      }
      const priceNum = Number(price);
      if (!Number.isFinite(priceNum) || priceNum < 0) {
        return res.status(400).json({ error: 'price must be a non-negative number' });
      }
      let dims;
      try {
        dims = parseProductDimensions(req.body || {});
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      const product = await Product.create({ name: name.trim(), price: priceNum, ...dims });
      res.json({ ok: true, product: serializeProduct(product) });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.put('/api/products/:id', requireAuth, async (req, res) => {
    try {
      const { name, price } = req.body || {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name is required' });
      }
      const priceNum = Number(price);
      if (!Number.isFinite(priceNum) || priceNum < 0) {
        return res.status(400).json({ error: 'price must be a non-negative number' });
      }
      let dims;
      try {
        dims = parseProductDimensions(req.body || {});
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      // $unset any dimension field not present in this request, so clearing a
      // field on the client (leaving it blank) actually clears it server-side
      // instead of leaving the old value behind.
      const unset = {};
      PRODUCT_DIMENSION_FIELDS.forEach((field) => {
        if (!(field in dims)) unset[field] = '';
      });
      const update = { $set: { name: name.trim(), price: priceNum, ...dims } };
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
  app.get('/api/orders', requireAuth, async (req, res) => {
    try {
      const filter = {};
      if (req.query.notifyResi === 'true') {
        filter.status = { $nin: ['Dibatalkan', 'Diterima'] };
        filter.trackingNumber = { $nin: [null, ''] };
      }
      const docs = await Order.find(filter).sort({ createdDate: -1 }).lean();
      const orders = docs.map(({ _id, __v, ...rest }) => ({ id: _id, ...rest }));
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

  app.delete('/api/orders/:id', requireAuth, async (req, res) => {
    try {
      await Order.findByIdAndDelete(req.params.id);
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
      const chatCache = new Map(); // phone -> chat doc
      const unresolvedProducts = new Set();
      const preOrderConversionOps = [];

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
        // we haven't seen before (e.g. never scanned from WA Web).
        let chat = chatCache.get(customerPhone);
        if (chat === undefined) {
          chat = await Chat.findById(customerPhone);
          if (!chat) {
            chat = await Chat.create({
              _id: customerPhone,
              name: customerName,
              phone: customerPhone,
              ownerNumber: ownerNumber || undefined,
              firstMessageDate: createdDate ? createdDate.toISOString() : undefined,
              firstSeenAt: new Date().toISOString(),
              manualClosing: status !== 'Dibatalkan',
              manualClosingUpdatedAt: new Date().toISOString(),
            });
            contactsCreated++;
          } else if (status !== 'Dibatalkan' && chat.manualClosing !== true) {
            // A real order is a conversion regardless of shipping status -
            // only a cancelled order shouldn't flip an existing contact.
            chat.manualClosing = true;
            chat.manualClosingUpdatedAt = new Date().toISOString();
            await chat.save();
          }
          chatCache.set(customerPhone, chat);
        }

        const volumeRaw = getCell(row, 'Volume');
        const zipcodeRaw = getCell(row, 'Zipcode');

        await Order.findByIdAndUpdate(
          noOrder,
          {
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
            },
          },
          { upsert: true, new: true }
        );
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
      const docs = await PreOrder.find(filter).sort({ orderDate: -1 }).lean();
      const preOrders = docs.map(({ _id, __v, ...rest }) => ({ id: _id, ...rest }));
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
        withinDateFilter(o.createdDate)
      );
      const filteredPreOrders = preOrders.filter((p) =>
        (productNames.length === 0 || productNames.includes(p.productName || '')) &&
        (!createdByEmail || (p.createdByEmail || '') === createdByEmail) &&
        withinDateFilter(p.orderDate)
      );

      // ---- Cards ----
      const chatMasuk = filteredChats.length;
      const closingCount = filteredChats.filter(isClosingChat).length;
      const closingRate = chatMasuk > 0 ? Math.round((closingCount / chatMasuk) * 1000) / 10 : 0;

      const nonCancelledOrders = filteredOrders.filter((o) => o.status !== 'Dibatalkan');
      const cancelledCount = filteredOrders.filter((o) => o.status === 'Dibatalkan').length;
      const deliveredCount = filteredOrders.filter((o) => o.status === 'Diterima').length;
      const totalOmset = nonCancelledOrders.reduce((sum, o) => sum + (o.price || 0), 0);
      const totalPesanan = filteredOrders.length;
      const avgOrderValue = nonCancelledOrders.length > 0 ? Math.round(totalOmset / nonCancelledOrders.length) : 0;
      const cancellationRate = totalPesanan > 0 ? Math.round((cancelledCount / totalPesanan) * 1000) / 10 : 0;

      const activePreOrders = filteredPreOrders.filter((p) => !p.convertedOrderId).length;

      // ---- Revenue by day (line chart) ----
      const revenueByDayMap = new Map();
      nonCancelledOrders.forEach((o) => {
        if (!o.createdDate) return;
        const day = new Date(o.createdDate).toISOString().slice(0, 10);
        revenueByDayMap.set(day, (revenueByDayMap.get(day) || 0) + (o.price || 0));
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
        entry.omset += o.price || 0;
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
          totalOmset, totalPesanan, avgOrderValue, cancellationRate,
          activePreOrders, chatMasuk, closingCount, closingRate,
        },
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
