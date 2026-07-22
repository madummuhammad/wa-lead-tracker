const mongoose = require('mongoose');

// Mirrors the shape of one entry in the extension's chrome.storage.local.chats
// object. _id is the same id the extension uses (phone digits, or the raw
// display name when no phone-like id could be derived).
const chatSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    name: String,
    phone: String,
    firstMessageDate: String,
    firstSeenAt: String,
    labels: { type: [String], default: [] },
    lastMessageFromMe: Boolean,
    lastMessageTime: String,
    lastMessageTimeRaw: String,
    unreadCount: Number,
    scrapedAt: String,
  },
  { timestamps: { createdAt: false, updatedAt: 'updatedAt' }, _id: false }
);

module.exports = mongoose.model('Chat', chatSchema);
