const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  businessName: { type: String },
  contactName: { type: String },
  email: { type: String },
  phone: { type: String },
  modules: { type: mongoose.Schema.Types.Mixed },
  preferredDate: { type: Date },
  status: { type: String, enum:['pending','confirmed','completed','cancelled'],default:'pending' },
  meetingLink: { type: String },
  notes: { type: String },
  scheduledAt: {type:Date,default:null},
  reviewNote: {type:String,maxlength:400,default:''},
  revision: {type:Number,default:0,min:0},
  decisions: {type:[new mongoose.Schema({action:String,from:String,to:String,note:String,scheduledAt:Date,meetingLink:String,actorId:mongoose.Schema.Types.ObjectId,at:Date},{_id:false,strict:'throw'})],default:[]}
}, { timestamps: true });
schema.index({status:1,_id:-1});

module.exports = mongoose.models.Appointment || mongoose.model('Appointment', schema);
