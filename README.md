# wa-lead-backend

Small Express + Mongoose API that syncs the WA Lead Tracker Chrome extension's
data (`chats`, `settings`) to MongoDB Atlas. Single-user, single API key -
this is not a multi-tenant service.

## Setup

1. `npm install`
2. `cp .env.example .env` and fill in:
   - `MONGODB_URI` - your Atlas connection string (create a database, e.g.
     `wa_lead_tracker`, in an existing or new cluster)
   - `API_KEY` - a random secret, e.g. `openssl rand -hex 32`
3. `npm run dev` (auto-restarts on file changes) or `npm start`

Test it's alive: `curl http://localhost:3000/health` should return `{"ok":true}`.

Test an authenticated route:
```
curl -H "Authorization: Bearer <your API_KEY>" http://localhost:3000/api/chats
```
Without the header (or with a wrong key) this should return `401`.

## Endpoints

- `GET /health` - no auth, liveness check
- `GET /api/chats` - all chats, `{ chats: { [id]: {...} } }`
- `PUT /api/chats` - upsert, body is `{ [id]: {...} }` (same shape as GET returns)
- `GET /api/settings` - `{ settings: {...} }`
- `PUT /api/settings` - upsert, body is the settings object directly
- `GET /api/products`, `POST /api/products`, `PUT /api/products/:id`, `DELETE /api/products/:id` - product catalog CRUD
- `GET /api/orders` - all imported orders, `{ orders: [...] }`
- `POST /api/orders/import` - multipart upload, field name `file`, an .xlsx order export (see below)

All routes under `/api` require `Authorization: Bearer <API_KEY>`.

### Order import (`POST /api/orders/import`)

Parses the COD fulfillment platform's order export (columns: `No. Order`,
`Pengiriman`, `Kurir`, `Penerima`, `No. HP Penerima`, `Alamat`, `Kota
penerima`, `Produk`, `Berat`, `Jumlah`, `Volume`, `Ongkos Kirim`, `Diskon
COD`, `Biaya COD`, `Harga Produk`, `Nilai COD`, `Status`, `Resi`, `Tanggal
Dibuat`, `Tanggal Diterima`, `Catatan`, `Kode Referensi`, `Status
Rekonsiliasi`, `Nama Admin Gudang`, `Nomor Admin Gudang`, `Zipcode`) and
upserts one `Order` document per row, keyed by `No. Order` - re-importing an
overlapping export updates existing rows (e.g. picks up a status change)
instead of duplicating them.

Side effects per row, by design (not just parsing):
- **Product**: matched by exact name against the `Product` catalog. If it
  doesn't exist yet, it's created with *only* the name - price/dimensions are
  left blank for the admin to fill in later on the Produk page. The order's
  own `price` is a separate, per-order snapshot (see below), never written
  back to the catalog.
- **Contact**: matched by phone (`Chat._id`) against existing contacts. If
  new, it's created with `firstMessageDate` set to the order's `Tanggal
  Dibuat`, and `manualClosing: true` unless the order's `Status` is
  `Dibatalkan` - a real order counts as a conversion regardless of shipping
  status. An *existing* contact gets the same closing flip only if it isn't
  already marked closing (never overwrites label-based closing or an earlier
  manual mark).
- **Nomor Admin Gudang → ownerNumber**: the export uses a 62-prefixed format
  (`6285726435813`); this system's `ownerNumber` (the Akun WA filter value)
  is entered 0-prefixed (`085726435813`). The import normalizes 62→0 so
  imported orders/contacts line up with the existing Akun WA filter instead
  of silently creating a second, unfiltered "account".
- **Price**: `Harga Produk` is blank in every row of the real export this was
  built against - the actual per-order value lives in `Nilai COD` instead.
  `price` prefers `Harga Produk` when present and falls back to `Nilai COD`,
  so a future export that does populate it takes precedence.

### Note on `manualClosing`

Manual "Tandai Closing" marks are stored per-chat (`Chat.manualClosing`), not
in the shared `Settings` document. `Settings` is a single global doc that
gets wholesale-replaced on every push, so if a per-device field like this
lived there, one device's sync would silently overwrite another device's
marks. Chats sync additively (upsert by `_id`), so per-chat is safe across
multiple WA accounts/devices sharing the same MongoDB. `Settings.manualClosing`
still exists for backward compatibility with old extension versions but is
only read as a fallback, never written to by current code.

The extension's pull merge normally lets local data win per chat id (it never
wants a stale server copy to clobber this device's own scan results). But
that meant `manualClosing` from one device could never reach another device
that already has the same chat locally (true for every chat on a shared WA
account). `Chat.manualClosingUpdatedAt` exists to fix that: it's stamped only
when a user explicitly toggles closing (never by routine scanning), so the
extension can compare that one field's timestamp across local/remote and
take whichever side changed it more recently, independent of every other
field on the chat.

## Structure

- `server/app.js` - `createApp()`, the Express app (routes + middleware), no `listen()` call
- `server/db.js` - `connectDB()`, shared by both entry points below
- `server/index.js` - local dev entry point (`npm run dev` / `npm start`)
- `netlify/functions/api.js` - Netlify Functions entry point (wraps the same
  `createApp()` with `serverless-http`, caches the DB connection across warm
  invocations)
- `netlify.toml` - maps `/api/*` and `/health` to the function

Both entry points share the exact same routes/models, so local dev and the
Netlify deployment always behave identically.

## Deploying to Netlify (free tier)

1. Push this folder to its own git repo (GitHub/GitLab/Bitbucket).
2. On [app.netlify.com](https://app.netlify.com), **Add new site → Import an
   existing project**, pick the repo.
3. Build settings: leave build command empty (nothing to build), publish
   directory can stay default - `netlify.toml` already declares
   `functions = "netlify/functions"`.
4. Site settings → **Environment variables** → add `MONGODB_URI` and
   `API_KEY` (same values as your local `.env` - never commit `.env` itself).
5. Deploy. Your API is then live at `https://<your-site>.netlify.app` - test
   with `curl https://<your-site>.netlify.app/health`.
6. Put `https://<your-site>.netlify.app` (no trailing slash, no `/api`) as
   the **Backend URL** in the extension's Options page - the extension
   already calls `/api/chats` and `/api/settings` on top of whatever base
   URL you give it.

## Deploying elsewhere (Railway, Render, Fly.io, etc.)

The `server/` folder is a plain Express app and doesn't need Netlify at all:
1. Push this folder to its own git repo.
2. Create a new Node service on your chosen platform, point it at the repo.
3. Set the start command to `npm start` (runs `server/index.js`).
4. Set `MONGODB_URI` and `API_KEY` as environment variables in the platform's
   dashboard (never commit `.env`).
5. Once deployed, note the public HTTPS URL - that's what goes into the
   extension's Options page ("Backend URL").
