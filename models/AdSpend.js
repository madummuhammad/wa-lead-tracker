const mongoose = require('mongoose');

// _id = `${campaignId}_${tanggal}` (tanggal kept as the exact "YYYY-MM-DD"
// string from the export) - a campaign's daily row is a natural key, so
// re-importing an overlapping export (Meta Ads Manager exports are always
// "last N days", which overlaps the previous export) upserts instead of
// duplicating, same pattern as Order._id.
const adSpendSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    campaignId: { type: String, required: true }, // ID Kampanye - kept as string, this is an 18-digit number that overflows JS's safe integer range
    campaignName: String, // Nama kampanye
    adSetName: String, // Nama set iklan
    date: Date, // Tanggal
    status: String, // Status Penayangan (active/inactive/not_delivering)
    reach: Number, // Jangkauan
    impressions: Number, // Impresi
    frequency: Number, // Frekuensi
    resultType: String, // Jenis hasil - varies per campaign (e.g. "Percakapan pesan dimulai" vs "Klik tautan"), not a fixed enum
    results: Number, // Hasil
    spend: Number, // Jumlah yang dibelanjakan (IDR)
    costPerResult: Number, // Biaya per hasil
    startDate: Date, // Mulai
    endDate: String, // Berakhir - usually "Berlangsung" (ongoing), not a parseable date
    // Denormalized from AdCampaignMapping at import/mapping time, not a live
    // reference lookup - see PUT /api/ads/campaigns/:campaignId, which
    // updates every existing row for a campaign when the mapping changes.
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  },
  { timestamps: true, _id: false }
);

module.exports = mongoose.model('AdSpend', adSpendSchema);
