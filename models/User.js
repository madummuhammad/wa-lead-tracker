const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    // admin: full access, including Pengaturan User (manage other accounts).
    // cs: customer service - Dashboard/Kontak/Produk/Pesanan/Pra-Pesanan only,
    // Pengaturan User hidden and blocked server-side (see requireAdmin).
    // user: legacy default, currently behaves the same as cs.
    role: { type: String, enum: ['admin', 'user', 'cs'], default: 'user' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
