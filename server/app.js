const express = require('express');
const path = require('path');
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
const Counter = require('../models/Counter');

const TOKEN_EXPIRY = '30d'; // personal tool, favor not re-logging-in over short-lived tokens
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function normalizeMatchName(name) {
  return String(name || '').trim().toLowerCase();
}

// One document per counter name, incremented atomically - see Counter.js.
async function getNextSequence(name) {
  const doc = await Counter.findByIdAndUpdate(name, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return doc.seq;
}

async function getNextPreOrderNumber() {
  const seq = await getNextSequence('preOrderNumber');
  return `PP-${String(seq).padStart(6, '0')}`;
}

// For each freshly imported/upserted Order, look for an existing PreOrder
// that represents the same sale and delete it - it has "graduated" into
// this real Order, which already holds the authoritative data, so nothing
// needs to be copied over. Matching, most to least confident:
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
// Orders with no match, and pre-orders with no match, are both left
// completely alone - that's the point, not a fallback.
async function consumeMatchingPreOrders(orders) {
  const allPreOrders = await PreOrder.find({}).lean();
  const consumedIds = new Set();

  orders.forEach((order) => {
    const available = allPreOrders.filter((p) => !consumedIds.has(String(p._id)));

    const refCodeMatch = order.refCode
      ? available.find((p) => p.orderNumber && p.orderNumber === order.refCode)
      : null;
    if (refCodeMatch) {
      consumedIds.add(String(refCodeMatch._id));
      return;
    }

    const resiMatch = order.trackingNumber
      ? available.find((p) => p.noResi && p.noResi === order.trackingNumber)
      : null;
    if (resiMatch) {
      consumedIds.add(String(resiMatch._id));
      return;
    }

    if (!order.customerPhone || !order.productName || !order.createdDate) return;
    const productKey = normalizeMatchName(order.productName);
    const candidates = available.filter((p) =>
      p.customerPhone === order.customerPhone &&
      normalizeMatchName(p.productName) === productKey &&
      p.orderDate && new Date(p.orderDate) <= new Date(order.createdDate)
    );
    if (candidates.length === 0) return;

    candidates.sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate)); // closest-from-below first
    const closestGapMs = new Date(order.createdDate) - new Date(candidates[0].orderDate);
    const tiedClosest = candidates.filter(
      (c) => new Date(order.createdDate) - new Date(c.orderDate) === closestGapMs
    );
    if (tiedClosest.length !== 1) return; // ambiguous - leave alone

    consumedIds.add(String(tiedClosest[0]._id));
  });

  if (consumedIds.size > 0) await PreOrder.deleteMany({ _id: { $in: Array.from(consumedIds) } });
  return consumedIds.size;
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

  app.get('/api/orders', requireAuth, async (req, res) => {
    try {
      const docs = await Order.find({}).sort({ createdDate: -1 }).lean();
      const orders = docs.map(({ _id, __v, ...rest }) => ({ id: _id, ...rest }));
      res.json({ orders });
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

      const productCache = new Map(); // name -> product doc
      const chatCache = new Map(); // phone -> chat doc

      let ordersImported = 0;
      let productsCreated = 0;
      let contactsCreated = 0;
      let rowsSkipped = 0;
      const importedOrders = []; // fed to consumeMatchingPreOrders() below

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

        if (!customerPhone) {
          rowsSkipped++;
          continue;
        }

        // Match the master Product catalog by exact name (assumed unique).
        // A brand-new product only gets its name filled in - price and
        // dimensions are left for the admin to fill in later on the Produk
        // page, since this order's price is just a snapshot for this order.
        let product = productCache.get(productName);
        if (product === undefined && productName) {
          product = await Product.findOne({ name: productName });
          if (!product) {
            product = await Product.create({ name: productName });
            productsCreated++;
          }
          productCache.set(productName, product);
        }

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
        const trackingNumber = getCell(row, 'Resi');
        const refCode = getCell(row, 'Kode Referensi');

        importedOrders.push({ customerPhone, productName, createdDate, trackingNumber, refCode });

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
              productName,
              productId: product ? product._id : undefined,
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
      }

      const preOrdersMoved = await consumeMatchingPreOrders(importedOrders);

      res.json({ ok: true, ordersImported, productsCreated, contactsCreated, rowsSkipped, preOrdersMoved });
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
    let productId;
    if (productName) {
      let product = await Product.findOne({ name: productName });
      if (!product) product = await Product.create({ name: productName });
      productId = product._id;
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

  app.get('/api/preorders', requireAuth, async (req, res) => {
    try {
      const docs = await PreOrder.find({}).sort({ orderDate: -1 }).lean();
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
      // Whoever runs a bulk import is the attributed creator for every row it
      // adds - there's no per-row "who entered this" in the sheet itself.
      const importerCreator = await resolvePreOrderCreator(req, {});

      const productCache = new Map();
      const chatCache = new Map();
      let added = 0;
      let skippedDuplicate = 0;

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

        if (customerPhone && productName) {
          if (!productCache.has(productName)) {
            let product = await Product.findOne({ name: productName });
            if (!product) product = await Product.create({ name: productName });
            productCache.set(productName, product);
          }
          if (!chatCache.has(customerPhone)) {
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
        }
        const product = productCache.get(productName);

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
          productName,
          productId: product ? product._id : undefined,
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

      res.json({ ok: true, added, skippedDuplicate });
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
