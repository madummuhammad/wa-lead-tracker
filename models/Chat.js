const mongoose = require('mongoose');

// Mirrors the shape of one entry in the extension's chrome.storage.local.chats
// object. _id is the same id the extension uses (phone digits, or the raw
// display name when no phone-like id could be derived).
const chatSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    name: String,
    phone: String,
    ownerNumber: String,
    // Lives on the chat record (not in the shared Settings doc) on purpose:
    // per-chat data syncs additively (upsert by _id), so two devices/accounts
    // marking different chats as closing never overwrite each other. A
    // global settings blob would get wholesale replaced by whichever device
    // pushed last, silently wiping the other device's closing marks.
    manualClosing: Boolean,
    // Stamped only when manualClosing is explicitly toggled (never touched by
    // routine scan merges), so pullFromBackend can tell whose closing mark is
    // actually newer instead of whichever device happened to sync/scan last.
    manualClosingUpdatedAt: String,
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
