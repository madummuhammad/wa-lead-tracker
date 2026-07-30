const mongoose = require('mongoose');

// _id is the order number ("No. Order") from the import file - it's already
// unique per order, so re-importing the same/overlapping export upserts
// instead of duplicating, and naturally picks up status changes over time
// (e.g. "Menunggu Dijemput" -> "Diterima" on a later export).
const orderSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    shippingType: String, // Pengiriman
    courier: String, // Kurir
    customerName: String, // Penerima
    customerPhone: String, // No. HP Penerima (digits only)
    address: String, // Alamat
    city: String, // Kota penerima
    productName: String, // Produk
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    weight: Number, // Berat
    qty: Number, // Jumlah
    volume: String, // Volume - format in source data is inconsistent ("-" or "10x18x18"), kept as-is
    shippingCost: Number, // Ongkos Kirim
    codDiscount: Number, // Diskon COD
    codFee: Number, // Biaya COD
    price: Number, // Harga Produk (unit price for this order, independent of the master Product price)
    hpp: Number, // Harga Pokok Penjualan - snapshot dari Product.hpp saat order dibuat, independen dari master (lihat komentar price di atas)
    codValue: Number, // Nilai COD
    status: String, // Status
    trackingNumber: String, // Resi
    createdDate: Date, // Tanggal Dibuat
    receivedDate: Date, // Tanggal Diterima
    note: String, // Catatan
    refCode: String, // Kode Referensi
    reconciliationStatus: String, // Status Rekonsiliasi
    warehouseAdminName: String, // Nama Admin Gudang
    ownerNumber: String, // Nomor Admin Gudang, normalized to match Chat.ownerNumber format
    zipcode: String,
    regency: String, // Kota/Kabupaten (penerima)
    district: String, // Kecamatan (penerima)
    province: String, // Provinsi (penerima)
    variant: String, // Variasi
    problem: String, // Problem
    returnDate: Date, // Tanggal Return
    returnToSellerDate: Date, // Tanggal Return Ke Seller
    csName: String, // Nama CS
    pickupType: String, // Tipe Pickup
    pickupTime: String, // Waktu Pickup - format sumbernya "YYYY-MM-DD HH:mm", disimpan apa adanya
    insurance: String, // Asuransi
    originalShippingCost: Number, // Ongkos Kirim Asli
    senderDistrict: String, // Kecamatan Pengirim
    senderRegency: String, // Kota/Kabupaten Pengirim
    senderProvince: String, // Provinsi Pengirim
    senderAddress: String, // Alamat Pengirim

    // ---- Problem-tracking fields (from the separate "problem tracking"
    // xlsx export - a different, narrower export than the main Pesanan one
    // above, re-imported over time to refresh these while an order is still
    // stuck). Populated only for orders that are/were problematic; left
    // undefined for every other order. Not cleared on re-import when an
    // order stops appearing in a fresh file - once status/problem above
    // (from the main Pesanan import) moves to Diterima/Return/Dibatalkan,
    // the order already drops out of every "sedang bermasalah" view
    // regardless of these fields, so there's nothing to clean up.
    ongkirBerangkat: Number, // Ongkir Berangkat
    ongkirPulang: Number, // Ongkir Pulang
    potensiRTS: Number, // Potensi RTS (ongkirBerangkat + ongkirPulang from the source file)
    problemStatusTerakhir: String, // Status Terakhir
    problemKategori: String, // Kategori Problem
    problemBuktiKurir: String, // Bukti Kurir - raw comma/newline-separated URL list as given
    problemRiwayat: String, // Last 5 Problem Detail - raw multi-line history text
    problemUpdatedAt: Date, // Tanggal Update Terakhir

    // Confirmed-sent follow-up log (see wa-ektension's floating panel
    // "Riwayat Follow Up") - a CS picking a template in the extension only
    // saves a pending entry locally in chrome.storage first; nothing lands
    // here until the CS explicitly marks it "Sudah Dikirim", so this array
    // only ever holds genuinely-sent follow-ups, never every template click.
    // No per-CS identity is tracked (the extension has no per-CS login,
    // only the shared API key) - ownerNumber (which WA account sent it) is
    // the closest attribution available.
    // Explicit sub-schema (not the plain-object array shorthand) with its
    // own `_id: true` - the shorthand form otherwise inherits the parent
    // Order schema's `_id: false` (Order itself uses a custom string _id),
    // which would silently leave every follow-up entry with no id to
    // reference for the undo/delete route below.
    followUps: [
      new mongoose.Schema(
        {
          templateLabel: String,
          sentAt: Date,
          ownerNumber: String,
        },
        { _id: true }
      ),
    ],
  },
  { timestamps: true, _id: false }
);

module.exports = mongoose.model('Order', orderSchema);
