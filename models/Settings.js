const mongoose = require('mongoose');

// Singleton document - this backend serves a single user (the extension
// owner), so there's exactly one settings record, always with _id "singleton".
const settingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'singleton' },
    staleDays: { type: Number, default: 3 },
    closingLabels: { type: [String], default: [] },
    manualClosing: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: false, updatedAt: 'updatedAt' }, _id: false }
);

module.exports = mongoose.model('Settings', settingsSchema);
