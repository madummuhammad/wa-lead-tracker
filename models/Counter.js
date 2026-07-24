const mongoose = require('mongoose');

// Simple atomic sequence generator (Mongoose has no built-in autoincrement).
// One document per counter name, incremented via findOneAndUpdate's atomic
// $inc - see getNextSequence() in server/app.js.
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

module.exports = mongoose.model('Counter', counterSchema);
