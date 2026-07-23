const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');

// One-time bootstrap so there's always at least one account to log into the
// web dashboard with. Only runs when the users collection is completely
// empty - never overwrites or resets an existing account.
const DEFAULT_ADMIN_EMAIL = 'muhammad.madum2018@gmail.com';
const DEFAULT_ADMIN_PASSWORD = 'Madummadum21';

async function ensureDefaultAdmin() {
  try {
    const existing = await User.findOne({});
    if (existing) return;
    const passwordHash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);
    await User.create({ email: DEFAULT_ADMIN_EMAIL, passwordHash, role: 'admin' });
    console.log('Default admin user created:', DEFAULT_ADMIN_EMAIL);
  } catch (e) {
    console.error('Failed to ensure default admin:', e.message);
  }
}

async function connectDB() {
  if (!process.env.MONGODB_URI) {
    throw new Error('Missing MONGODB_URI in environment');
  }
  if (mongoose.connection.readyState === 1) return; // already connected (warm serverless invocation)

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  await mongoose.connection.db.admin().command({ ping: 1 });
  console.log('Connected to MongoDB, database:', mongoose.connection.name);
  await ensureDefaultAdmin();
}

module.exports = { connectDB };
