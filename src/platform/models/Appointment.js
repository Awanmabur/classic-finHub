const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  businessName: { type: String },
  contactName: { type: String },
  email: { type: String },
  phone: { type: String },
  modules: { type: mongoose.Schema.Types.Mixed },
  preferredDate: { type: Date },
  status: { type: String },
  meetingLink: { type: String },
  notes: { type: String }
}, { timestamps: true });

module.exports = mongoose.models.Appointment || mongoose.model('Appointment', schema);
