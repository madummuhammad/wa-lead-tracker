const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
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
