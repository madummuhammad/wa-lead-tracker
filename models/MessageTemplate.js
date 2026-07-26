const mongoose = require('mongoose');

// Quick-reply templates for the extension's per-chat "Kabar Pra-Pesanan"
// badge - managed here (web dashboard), mirrored read-only into the
// extension (see wa-ektension/background.js pullMessageTemplates), same
// pattern as the Product catalog. `text` may contain a literal "{{nama}}"
// placeholder, replaced client-side (in the extension) with the WhatsApp
// contact's display name when a template is picked.
const messageTemplateSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true },
    text: { type: String, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('MessageTemplate', messageTemplateSchema);
