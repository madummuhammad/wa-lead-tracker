const mongoose = require('mongoose');

async function connectDB() {
  if (!process.env.MONGODB_URI) {
    throw new Error('Missing MONGODB_URI in environment');
  }
  if (mongoose.connection.readyState === 1) return; // already connected (warm serverless invocation)

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  await mongoose.connection.db.admin().command({ ping: 1 });
  console.log('Connected to MongoDB, database:', mongoose.connection.name);
}

module.exports = { connectDB };
