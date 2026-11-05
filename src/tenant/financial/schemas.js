'use strict';
const { Schema } = require('mongoose');
const ID = Schema.Types.ObjectId;
const CURRENCIES = ['UGX', 'KES'];
const SOURCES = ['mobile_money', 'money_transfer', 'banking', 'forex'];
const STATUSES = ['pending_verification', 'provider_verified', 'provider_failed', 'exception', 'reconciled'];
function appendOnly(schema) {
  schema.set('strict', 'throw');
  schema.set('versionKey', false);
  schema.pre('save', function (next) { next(this.isNew ? undefined : new Error('Financial evidence is append-only')); });
  for (const op of ['updateOne','updateMany','replaceOne','findOneAndUpdate','findOneAndReplace',
    'deleteOne','deleteMany','findOneAndDelete']) schema.pre(op, function(next){next(new Error('Financial evidence is append-only'));});
}
const line = new Schema({
  accountCode: {type:String,required:true,immutable:true},
  side: {type:String,enum:['debit','credit'],required:true,immutable:true},
  amountMinor: {type:String,required:true,immutable:true}
}, {_id:false,strict:'throw'});
const operation = new Schema({
  branchId: {type:ID,required:true,immutable:true},
  createdBy: {type:ID,required:true,immutable:true},
  sourceType: {type:String,enum:SOURCES,required:true,immutable:true},
  sourceRef: {type:String,required:true,immutable:true},
  provider: {type:String,required:true,immutable:true},
  providerRef: {type:String,required:true,immutable:true},
  currency: {type:String,enum:CURRENCIES,required:true,immutable:true},
  amountMinor: {type:Schema.Types.Decimal128,required:true,immutable:true},
  ledgerLines: {type:[line],required:true,immutable:true},
  fingerprint: {type:String,required:true,immutable:true},
  status: {type:String,enum:STATUSES,required:true,default:'pending_verification'},
  verifiedAt: {type:Date,default:null},
  reconciledAt: {type:Date,default:null},
  journalId: {type:ID,default:null},
  createdAt: {type:Date,default:Date.now,immutable:true}
}, {strict:'throw',versionKey:false});
operation.index({sourceType:1,sourceRef:1},{unique:true});
operation.index({provider:1,providerRef:1},{unique:true});
operation.index({branchId:1,status:1,createdAt:1});
operation.index({status:1,createdAt:1});
const evidence = new Schema({
  provider: {type:String,required:true,immutable:true},
  kind: {type:String,enum:['callback','settlement'],required:true,immutable:true},
  eventId: {type:String,required:true,immutable:true},
  sourceType: {type:String,enum:SOURCES,required:true,immutable:true},
  sourceRef: {type:String,required:true,immutable:true},
  providerRef: {type:String,required:true,immutable:true},
  currency: {type:String,enum:CURRENCIES,required:true,immutable:true},
  amountMinor: {type:Schema.Types.Decimal128,required:true,immutable:true},
  claimedStatus: {type:String,enum:['confirmed','failed'],required:true,immutable:true},
  issuedAt: {type:Date,required:true,immutable:true},
  digest: {type:String,required:true,immutable:true},
  operationId: {type:ID,default:null,immutable:true},
  matchStatus: {type:String,enum:['matched','unmatched'],required:true,immutable:true},
  receivedAt: {type:Date,default:Date.now,immutable:true}
});
appendOnly(evidence);
evidence.index({provider:1,kind:1,eventId:1},{unique:true});
evidence.index({sourceType:1,sourceRef:1,kind:1,claimedStatus:1});
evidence.index({operationId:1,matchStatus:1});
const exception = new Schema({
  branchId: {type:ID,default:null,immutable:true},
  operationId: {type:ID,default:null,immutable:true},
  evidenceId: {type:ID,required:true,immutable:true},
  code: {type:String,enum:['UNKNOWN_OPERATION','ECONOMICS_MISMATCH','CONFLICTING_CALLBACK','DUPLICATE_SETTLEMENT','STATE_CONFLICT'],required:true,immutable:true},
  status: {type:String,enum:['open','closed'],required:true,default:'open'},
  resolvedBy: {type:ID,default:null},
  resolvedAt: {type:Date,default:null},
  resolutionNote: {type:String,default:null,maxlength:400},
  createdAt: {type:Date,default:Date.now,immutable:true}
},{strict:'throw',versionKey:false});
exception.index({evidenceId:1},{unique:true});
exception.index({operationId:1,status:1,createdAt:1});
exception.index({branchId:1,status:1,createdAt:1});
exception.index({status:1,createdAt:1});
module.exports = {operation,evidence,exception,SOURCES,CURRENCIES,STATUSES};
