const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // Built once at creation from two required, admin-typed parts
    // ("{part1}-{part2}" + an auto-generated sequence number appended with
    // no separator, to stay unique even if two products want the same two
    // parts - see generateUniqueSku() in server/app.js). Not required at the
    // schema level for the same reason as price below (auto-created
    // products from an order import have no SKU yet); after creation it's
    // just a plain editable text field, not regenerated on edit.
    // `sparse: true` lets every pre-existing product (created before this
    // field existed, so `sku` is unset) coexist under the unique index -
    // only products that DO have a sku are checked against each other.
    sku: { type: String, trim: true, unique: true, sparse: true },
    warehouseAddress: { type: String, trim: true }, // Alamat Gudang
    // Not required at the schema level: products auto-created from an order
    // import (see Order import below) only have a name at first, with price
    // filled in later by the admin. The manual "Tambah Produk Baru" form
    // still requires price - that's enforced in the route handlers below.
    price: { type: Number, min: 0 },
    weight: { type: Number, min: 0 }, // gram
    volume: { type: Number, min: 0 }, // cm3
    length: { type: Number, min: 0 }, // cm
    width: { type: Number, min: 0 }, // cm
    height: { type: Number, min: 0 }, // cm
  },
  { timestamps: true }
);

module.exports = mongoose.model('Product', productSchema);
