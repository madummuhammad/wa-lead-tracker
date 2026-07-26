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
- `GET /api/message-templates`, `POST /api/message-templates`, `PUT /api/message-templates/:id`, `DELETE /api/message-templates/:id` - quick-reply template CRUD (`{label, text}`), managed on the "Template Pesan" dashboard page, mirrored read-only into the extension's per-chat "Kabar Pra-Pesanan" badge (see `wa-ektension/background.js` `pullMessageTemplates`)
- `GET /api/orders` - all imported orders, `{ orders: [...] }`
- `PUT /api/orders/:id` - edit one order (same Product-catalog-matching side effect as import if `productName` changes)
- `DELETE /api/orders/:id` - delete one order
- `POST /api/orders/delete` - bulk delete, body is `{ ids: [...] }`
- `POST /api/orders/import` - multipart upload, field name `file`, an .xlsx order export (see below). Optional `?onlyMatched=true` restricts it to rows that match an existing Pra-Pesanan, skipping everything else outright (used by the Pra-Pesanan page's "Impor dari Lincah" button; the Pesanan page's own import omits it and imports every row as before). Optional `?dryRun=true` + `productMapping` field for the product-resolution flow (see below)
- `GET /api/preorders` - `?status=active` (default) for not-yet-converted pre-orders, `?status=converted` for ones that already graduated into an Order, `?status=all` for both (needed for historical/funnel reporting)
- `POST /api/preorders`, `PUT /api/preorders/:id`, `DELETE /api/preorders/:id` - pre-order CRUD
- `POST /api/preorders/delete` - bulk delete, body is `{ ids: [...] }`
- `POST /api/preorders/import` - multipart upload, field name `file`, bulk-adds from the manual "Data Order" tracker sheet (see below). Same `?dryRun=true` + `productMapping` product-resolution flow as the order import
- `GET /api/users/mini` - `{ users: [{id, email}, ...] }`, any authenticated user (unlike `GET /api/users` below) - just enough to populate the "Dibuat Oleh" picker on Pra-Pesanan
- `GET /api/dashboard/stats` - server-side aggregated numbers for the Dashboard page (cards, charts, funnel) so the browser never has to fetch and crunch the whole `Chat`/`Order`/`PreOrder` collections just to show a few totals. Optional query params, all combinable: `from`, `to` (`YYYY-MM-DD`, inclusive), `ownerNumber`, `productName`, `createdByEmail`. Response shape: `{ cards, revenueByDay, chatsByDay, ordersByProduct, preOrdersByCreator, closingRateByOwner, leadsVsOrdersByProduct, productTaggingCoverage, funnel, filterOptions }` - `filterOptions` is always computed from the *unfiltered* data so the dropdowns never shrink based on the current selection.

All routes under `/api` require `Authorization: Bearer <API_KEY>`.

### Users & roles

Real dashboard users (as opposed to the extension's own `API_KEY`) log in via
`POST /api/auth/login` and are managed via `GET`/`POST /api/users`,
`DELETE /api/users/:id` - all three require `role: 'admin'` (`requireAdmin`
middleware). `User.role` is one of:

- **`admin`** - full access, including the "Pengaturan User" page (create/
  delete other accounts).
- **`cs`** - customer service. Sees Dashboard, Kontak, Produk, Pesanan, and
  Pra-Pesanan only - "Pengaturan User" is hidden client-side (`showAppScreen()`
  toggles `usersNavBtn` based on role) and blocked server-side regardless
  (`requireAdmin` rejects anything that isn't `admin`, so hiding the nav
  button is UX, not the actual security boundary).
- **`user`** - legacy default from before the `cs` role existed; behaves
  identically to `cs` today (same pages hidden/visible).

None of the other API routes (`chats`, `products`, `orders`, `preorders`,
`dashboard/stats`) are role-gated beyond being logged in at all - a `cs`
account has the same data access as `admin` on every page it can see, the
restriction is purely about which pages are reachable from the sidebar.

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
- **Product**: resolved, never created. In priority order: (1) if the row
  matches an existing Pra-Pesanan (see the matching cascade below), that
  Pra-Pesanan's own already-real catalog product wins - the row's raw
  "Produk" text is ignored in favor of it; (2) otherwise an exact-name match
  against the `Product` catalog; (3) otherwise whatever the admin explicitly
  picked via `productMapping` (see "Product resolution" below). A row whose
  product can't be resolved by any of those is skipped entirely, not
  imported with a blank/guessed product. The order's own `price` is a
  separate, per-order snapshot (see below), never written back to the
  catalog regardless of which of the three resolved it.
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
- Any existing `PreOrder` that matches a row (see `findPreOrderMatch()`) is
  marked **converted**, not deleted - it has "graduated" into this real
  Order, which already holds the authoritative data. See Pre-Orders below.

With `?onlyMatched=true`, the gate flips: a row is only turned into an Order
(and only gets its Product/Chat side effects) if it matches an existing,
not-yet-converted `PreOrder` via that same cascade - unmatched rows are
skipped entirely, not imported. This is what the Pra-Pesanan page's "Impor
dari Lincah" button uses, so that page never grows Orders/contacts for sales
nobody tracked as a Pra-Pesanan first; the Pesanan page's own import omits
the flag and keeps importing every row unconditionally, exactly as before.
In practice `onlyMatched` imports never hit the "unresolved product" path
below, since every row they process already has a matched Pra-Pesanan
supplying its product.

**Product resolution (`?dryRun=true` + `productMapping`)**: since this route
never creates a `Product`, a row whose text doesn't match anything needs a
human decision. Call the route once with `?dryRun=true` (same file, no
writes at all) to get back `{ dryRun: true, unresolvedProducts: [...] }` -
the distinct raw "Produk" names nothing could resolve. Show the admin a
picker for each, then call the route again without `dryRun`, this time with
a `productMapping` field (a JSON string, sent as a normal multipart text
field alongside the same file): `{ "<raw name>": { "productId": "...",
"productName": "..." } }`. Rows whose raw name isn't a key in the supplied
mapping (or where dryRun wasn't run first) are simply skipped, counted in
the response's `rowsProductUnresolvedSkipped`.

### Pre-Orders (Pra-Pesanan)

`PreOrder` is a manually-tracked pre-order - same columns as the "Data Order"
sheet used *before* an order is actually placed on lincah.id (`orderDate`,
`customerName`, `customerPhone`, `address`, `productName`, `qty`,
`unitPrice`, `totalPrice`, `shippingCost`, `totalBill`, `paymentMethod`,
`paymentStatus`, `courier`, `noResi`, `statusOrder`, `campaignSource`,
`note`, `lincah`, `aneka`, `ctt`), plus two fields generated by this system
itself: `orderNumber` and `createdByUserId`/`createdByEmail` (see below). It's
**fully CRUD-managed** via `GET`/`POST`/`PUT /:id`/`DELETE /:id` - the bulk
`POST /api/preorders/import` (the "Data Order" sheet, header auto-detected in
the first 5 rows since the sheet has a title banner above it) is just one way
to add rows, additive and deduplicated by phone + product name + order date
(the closest thing this sheet has to a natural key) so re-importing the
same/an overlapping file doesn't pile up duplicates - it never touches or
replaces existing rows. Product resolution works the same way as the Order
import (exact catalog name match, else the `?dryRun=true` + `productMapping`
picker flow - see above; never auto-created) for both the bulk import and
manual create/update via the form (the form's Produk field is a dropdown of
existing products, so it can only send a name that's already unresolved in
the rare case of an edit resubmitting a since-renamed/deleted one - that just
leaves `productId` unset rather than creating a duplicate). Contact
auto-create on new phone numbers still applies to both, except a pre-order
**never** touches `manualClosing` - it isn't a confirmed conversion yet, only
the actual dispatched Order represents that.

**`orderNumber`** is a short, human-typeable code - `PP` + `YYYYMMDD` + 4
random base36 characters, no separators, e.g. `PP202607269F3K` - generated
once at creation via `generateRandomOrderSuffix()`/`getNextPreOrderNumber()`
and never changed afterward. The date makes it sortable/readable at a glance;
the trailing 4 characters are what actually make it unguessable - seeded
from both a nanosecond-resolution clock reading and `crypto.randomBytes`
(real OS entropy, not `Math.random()`), then hashed, so nothing about one
code lets you guess another created the same day. `getNextPreOrderNumber()`
retries (up to 5x) on the astronomically unlikely chance of a same-day
collision; the `unique` index on `orderNumber` is the actual guarantee
either way. It's meant to be copied by hand into lincah.id's own "Kode
Referensi" field when the order is actually placed there, so the resulting
`Order.refCode` gives an exact, unambiguous link back - see matching below.

**`createdByUserId`/`createdByEmail`** track which team member (see `User`)
is attributed to a pre-order - a business attribution field the owner can
reassign (e.g. entering on someone's behalf), not a locked audit trail.
Defaults to whoever's logged in, but `POST`/`PUT` accept a `createdByUserId`
in the body to attribute it to any other real user instead. A bulk import
attributes every row it adds to whoever ran the import.

**Moving to Pesanan on match** (`findPreOrderMatch()` in `server/app.js`) is
the main point of this feature, run every time `POST /api/orders/import`
runs (so it also catches pre-orders left unmatched by an earlier lincah
import, without re-touching the tracker sheet at all), most to least
confident:
1. If a `PreOrder.orderNumber` matches an imported `Order.refCode`, that's
   the most deliberate signal there is - the user copied it into lincah's
   Kode Referensi field by hand.
2. Otherwise, if `PreOrder.noResi` matches `Order.trackingNumber`, that's
   exact and unambiguous too, just discovered later (once shipping exists).
3. Otherwise, fall back to phone + product name (case/whitespace-insensitive),
   among pre-orders dated on/before the order, picking the closest one -
   unless there's a tie, which is left alone rather than guessed (a wrong
   match is worse than none, since a pre-order is just a plan).
4. A matched `PreOrder` is marked **converted** (`convertedOrderId` set to the
   matching `Order._id`, `convertedAt` stamped) rather than deleted - the
   Order already has the authoritative data, but keeping the row lets the
   Dashboard funnel and CS-productivity charts count it historically. `GET
   /api/preorders` filters converted rows out by default, so the Pra-Pesanan
   page's active list looks exactly like it did when matches were hard-deleted.
   Orders with no match, and pre-orders with no match, are both left
   completely alone; nothing ever guesses.
`"No HP/WA"` is normalized from whatever format the sheet stores it in (often
a plain number, which silently drops a leading 0) to the same 62-prefixed
format `Order.customerPhone` uses, or matching would just never succeed.

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

`Chat.product`/`productUpdatedAt` and `Chat.preOrderNotified`/
`preOrderNotifiedOrderNumber`/`preOrderNotifiedUpdatedAt` follow the exact
same per-field-timestamp pattern (see the extension's `background.js`
`PER_FIELD_MERGE_KEYS`) - the latter two mark, from the extension's per-chat
badge, whether a contact with an active Pra-Pesanan has been told their order
is being processed, tied to that specific Pra-Pesanan's `orderNumber` so a
later, unrelated Pra-Pesanan for the same contact doesn't inherit a stale
"already notified" mark.

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
