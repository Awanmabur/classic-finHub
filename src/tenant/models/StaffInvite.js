const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  name: { type: String, required:true, maxlength:120 },
  email: { type: String, required:true, lowercase:true, trim:true, maxlength:254 },
  role: { type: String, required:true, enum: ['Branch Manager','Mobile Money Operator','Money Transfer Operator','Banking Operator','Forex Operator','Reconciliation Officer','Auditor','Reports Analyst','Analytics Analyst','Approval Requester','Approval Officer','Viewer'] },
  branchId: { type:String, required:true, match:/^[a-f0-9]{24}$/i },
  allowedModules: { type:[String], default:[] },
  tokenHash: { type: String, required:true, unique:true },
  status: { type: String, required:true, enum: ['pending','accepted','expired','cancelled'], default:'pending' },
  expiresAt: { type: Date, required:true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, required:true },
  acceptedAt: { type:Date, default:null }
}, {timestamps:true,strict:'throw'});
schema.index({email:1},{unique:true,partialFilterExpression:{status:'pending'}});
schema.index({expiresAt:1});
schema.index({branchId:1,status:1,expiresAt:-1});
module.exports=schema;
