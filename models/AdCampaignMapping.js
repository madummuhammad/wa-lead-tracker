const mongoose = require('mongoose');

// _id = campaignId (ID Kampanye) - one product per campaign, remembered once
// set so re-importing that campaign's daily data never re-asks which
// product it belongs to (see POST /api/ads/import).
const adCampaignMappingSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    campaignName: String, // denormalized, for display without a join
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  },
  { timestamps: true, _id: false }
);

module.exports = mongoose.model('AdCampaignMapping', adCampaignMappingSchema);
