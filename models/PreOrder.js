const mongoose = require('mongoose');

// A manually-tracked pre-order (recorded before the order is actually placed
// on lincah.id), same columns as the "Data Order" tracking sheet. Fully
// CRUD-managed (see /api/preorders* routes in server/app.js) - bulk import
// from the sheet is just one way to add rows, not the only way.
//
// When a lincah Order import (POST /api/orders/import) finds an Order that
// matches one of these (by reference code, resi, or phone+product+closest
// date), it's marked converted (convertedOrderId/convertedAt) rather than
// deleted - it has "graduated" into a real Order, which already holds the
// authoritative data, so there's nothing left to edit here, but the record
// stays for historical conversion reporting (see GET /api/dashboard/stats).
// GET /api/preorders excludes converted ones by default, so the *active*
// list still looks exactly like a hard delete happened. Pre-orders that
// never find a match are simply left alone indefinitely.
const preOrderSchema = new mongoose.Schema(
  {
    convertedOrderId: String, // Order._id this graduated into, once matched
    convertedAt: Date,
    // Short, human-typeable code (e.g. "PP202607269F3K") generated once
    // at creation and never changed - meant to be copied into lincah.id's
    // "Kode Referensi" field when the order is actually placed there, so
    // the resulting Order.refCode gives consumeMatchingPreOrders() an exact,
    // unambiguous match instead of relying only on resi or phone+product+date.
    // The date prefix is just for readability/sorting - the trailing 4 chars
    // are what actually make it unguessable (see getNextPreOrderNumber() in
    // server/app.js), not a sequential counter.
    orderNumber: { type: String, unique: true },
    createdByUserId: String, // which team member (see User) entered this
    createdByEmail: String, // denormalized for display without a join
    orderDate: Date, // Tanggal Order
    customerName: String, // Nama Customer
    customerPhone: String, // No HP/WA, normalized to the same 62-prefixed format as Order.customerPhone
    address: String, // Alamat Lengkap
    productName: String, // Produk
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    qty: Number,
    unitPrice: Number, // Harga Satuan
    totalPrice: Number, // Total Harga
    shippingCost: Number, // Ongkir
    totalBill: Number, // Total Tagihan
    paymentMethod: String, // Metode Bayar
    paymentStatus: String, // Status Bayar
    courier: String, // Kurir
    noResi: String, // as typed manually, or as known so far - used to match against a real lincah Order
    statusOrder: String, // "Status Order" - manual tracking status
    campaignSource: String, // Sumber Campaign
    note: String, // Catatan
    lincah: Boolean, // LINCAH column - exact meaning not confirmed, kept as-is
    aneka: Boolean, // ANEKA column - exact meaning not confirmed, kept as-is
    ctt: String, // CTT column - exact meaning not confirmed, kept as-is
  },
  { timestamps: true }
);

module.exports = mongoose.model('PreOrder', preOrderSchema);
