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
    // Which product this lead is tied to (picked in WhatsApp Web when the
    // chat comes in) - same per-chat-not-settings reasoning as manualClosing
    // above, and same paired "*UpdatedAt" timestamp so the extension's pull
    // merge can tell whose product pick is newer across devices instead of
    // one device's local copy always winning.
    product: String,
    productUpdatedAt: String,
    // Whether this contact has been told (by hand, in WhatsApp) that their
    // active Pra-Pesanan is being processed - set from the extension's
    // per-chat badge, same per-chat-not-settings/paired-timestamp reasoning
    // as manualClosing above. preOrderNotifiedOrderNumber records *which*
    // Pra-Pesanan (by its own orderNumber) the flag refers to, so a later,
    // different Pra-Pesanan for the same contact doesn't inherit a stale
    // "already notified" from a previous, unrelated order.
    preOrderNotified: Boolean,
    preOrderNotifiedOrderNumber: String,
    preOrderNotifiedUpdatedAt: String,
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
