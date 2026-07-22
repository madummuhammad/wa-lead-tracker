require('dotenv').config();
const mongoose = require('mongoose');
const { createApp } = require('./app');
const { connectDB } = require('./db');

async function start() {
  if (!process.env.MONGODB_URI) {
    console.error('Missing MONGODB_URI in environment - copy .env.example to .env and fill it in.');
    process.exit(1);
  }
  if (!process.env.API_KEY) {
    console.error('Missing API_KEY in environment - copy .env.example to .env and fill it in.');
    process.exit(1);
  }

  try {
    await connectDB();
  } catch (e) {
    console.error('Failed to connect to MongoDB - check MONGODB_URI in .env:', e.message);
    process.exit(1);
  }

  mongoose.connection.on('error', (err) => {
    console.error('MongoDB connection error:', err.message);
  });

  const app = createApp();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`wa-lead-backend listening on port ${port}`));
}

start();
