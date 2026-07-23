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

const TOKEN_EXPIRY = '30d'; // personal tool, favor not re-logging-in over short-lived tokens
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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
              trackingNumber: getCell(row, 'Resi'),
              createdDate,
              receivedDate: parseIndonesianDate(getCell(row, 'Tanggal Diterima')),
              note: getCell(row, 'Catatan'),
              refCode: getCell(row, 'Kode Referensi'),
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

      res.json({ ok: true, ordersImported, productsCreated, contactsCreated, rowsSkipped });
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
