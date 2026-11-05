const mongoose = require('mongoose');
const { NAME } = require('../../config/tenantDatabaseName');
const schema = new mongoose.Schema({
  name: { type: String, required: true, maxlength: 150 },
  slug: { type: String, required: true, unique: true, match: NAME },
  dbName: { type: String, required: true },
  owner: { type: String, maxlength: 150 },
  email: { type: String, required: true }, phone: { type: String },
  plan: { type: String, required: true },
  status: { type: String, enum: ['trial','active','past_due','suspended'], required: true },
  setupStatus: { type: String, enum: ['invited','complete'], default: 'complete' },
  enabledModules: { type: [String], default: [] },
  moduleGrants: {type:[new mongoose.Schema({
    moduleKey:{type:String,required:true,immutable:true,match:/^[a-z][a-z0-9_]{1,40}$/},
    status:{type:String,required:true,enum:['granted','revoked']},
    periodStart:{type:Date,required:true},periodEnd:{type:Date,required:true},
    generation:{type:Number,required:true,min:1},
    priceMonthlyMinor:{type:Number,required:true,min:0},currency:{type:String,enum:['USD'],required:true},
    limits:{users:{type:Number,required:true,min:1},branches:{type:Number,required:true,min:1},recordsPerMonth:{type:Number,required:true,min:0}}
  },{_id:false,strict:'throw'})],default:[]},
  seatsReserved: { type: Number, default: 1, min: 1 },
  branchCount: { type: Number, default: 0, min: 0 },
  trialEndsAt: { type: Date, default: null },
  // Authoritative, snapshotted subscription entitlement. Absent on legacy tenants
  // until an explicit controlled migration or audited platform grant.
  subscription: {type: new mongoose.Schema({
    planCode:{type:String,required:true},planVersion:{type:Number,required:true,min:1},planName:{type:String,required:true},
    status:{type:String,enum:['trial','granted','revoked'],required:true},
    source:{type:String,enum:['new_tenant_trial','manual_admin_grant'],required:true},
    periodStart:{type:Date,required:true},periodEnd:{type:Date,required:true},
    generation:{type:Number,min:1,required:true},
    currency:{type:String,enum:['USD'],required:true},priceMonthlyMinor:{type:Number,min:0,required:true},priceYearlyMinor:{type:Number,min:0,required:true},
    modules:{type:[String],required:true},
    limits:{users:{type:Number,required:true,min:1},branches:{type:Number,required:true,min:1},
      transactionsPerMonth:{type:Number,required:true,min:0},smsPerMonth:{type:Number,required:true,min:0},storageMb:{type:Number,required:true,min:0}}
  },{_id:false,strict:'throw'}),default:undefined}
}, { timestamps: true, strict: 'throw', optimisticConcurrency:true });
schema.index({status:1,createdAt:-1});
module.exports = mongoose.models.Tenant || mongoose.model('Tenant', schema);
