'use strict';
const {Schema}=require('mongoose');
const {ensureModelIndexes}=require('../../config/ensureModelIndexes');
const O=Schema.Types.ObjectId;
const S=Schema.Types;
const recordSchema=new Schema({
 tenantId:{type:O,required:true,immutable:true},
 branchId:{type:O,required:true,immutable:true},
 actorId:{type:O,required:true,immutable:true},
 idempotencyKey:{type:String,required:true,immutable:true},
 providerReference:{type:String,required:true,immutable:true,maxlength:120},
 network:{type:String,required:true,immutable:true,maxlength:40},
 operation:{type:String,enum:['withdraw_provider_receive_cash','deposit_cash_send_provider'],required:true,immutable:true},
 walletAccountId:{type:O,required:true,immutable:true},
 cashAccountId:{type:O,required:true,immutable:true},
 providerCurrency:{type:String,required:true,immutable:true},
 cashCurrency:{type:String,required:true,immutable:true},
 providerAmountMinor:{type:S.Decimal128,required:true,immutable:true},
 cashAmountMinor:{type:S.Decimal128,required:true,immutable:true},
 walletDeltaMinor:{type:S.Decimal128,required:true,immutable:true},
 cashDeltaMinor:{type:S.Decimal128,required:true,immutable:true},
 rateId:{type:O,required:true,immutable:true},
 rateVersion:{type:Number,required:true,immutable:true},
 rateSide:{type:String,enum:['buy','sell'],required:true,immutable:true},
 rateDecimal:{type:String,required:true,immutable:true},
 providerEvidenceId:{type:String,required:true,immutable:true,maxlength:120},
 providerVerifiedAt:{type:Date,default:null,immutable:true},
 providerEvidenceKind:{type:String,enum:['signed_provider','operator_attested'],required:true,immutable:true},
 providerSettlementState:{type:String,enum:['verified','unverified'],required:true,immutable:true},
 cashConfirmedAt:{type:Date,required:true,immutable:true},
 complianceGrantId:{type:O,required:true,immutable:true},
 journalBatchId:{type:O,required:true,immutable:true},
 fxProfitState:{type:String,enum:['unmeasured_cost_basis'],required:true,default:'unmeasured_cost_basis',immutable:true},
 settledAt:{type:Date,required:true,immutable:true}
},{strict:'throw',versionKey:false,timestamps:{createdAt:true,updatedAt:false}});
// Posted financial evidence cannot be edited or erased. Corrections require a new linked journal.
for(const op of ['updateOne','updateMany','replaceOne','findOneAndUpdate','findOneAndReplace','deleteOne','deleteMany','findOneAndDelete'])
 recordSchema.pre(op,function(next){next(new Error('Posted cross-currency evidence is append-only'));});
recordSchema.pre('save',function(next){next(this.isNew?null:new Error('Posted cross-currency evidence is append-only'));});
recordSchema.index({tenantId:1,idempotencyKey:1},{unique:true});
recordSchema.index({tenantId:1,network:1,providerReference:1},{unique:true});
recordSchema.index({tenantId:1,providerEvidenceId:1},{unique:true});
recordSchema.index({tenantId:1,branchId:1,settledAt:-1,_id:-1});
const grantSchema=new Schema({
 tenantId:{type:O,required:true,immutable:true},
 branchId:{type:O,required:true,immutable:true},
 walletAccountId:{type:O,required:true,immutable:true},
 cashAccountId:{type:O,required:true,immutable:true},
 providerNetwork:{type:String,required:true,immutable:true},
 status:{type:String,enum:['pending_review','approved','rejected','suspended','revoked'],required:true,default:'pending_review'},
 requestedBy:{type:O,default:null,immutable:true},requestedAt:{type:Date,default:Date.now,immutable:true},
 verificationNote:{type:String,maxlength:500,default:''},
 permittedCurrencyPair:{type:String,required:true,immutable:true},
 providerAuthorizationReference:{type:String,required:true,maxlength:200},
 regulatoryAuthorizationReference:{type:String,required:true,maxlength:200},
 approvedBy:{type:O,default:null},
 reviewedAt:{type:Date,default:null},reviewNote:{type:String,maxlength:500,default:''},
 revision:{type:Number,default:0,min:0},
 expiresAt:{type:Date,required:true}
},{timestamps:true,strict:'throw'});
grantSchema.index({tenantId:1,branchId:1,walletAccountId:1,cashAccountId:1,status:1});
const model=(conn,name,schema)=>conn.models[name]||conn.model(name,schema);
function records(conn){return model(conn,'MomoFxCrossCurrencyRecordV1',recordSchema);}
function grants(conn){return model(conn,'MomoFxComplianceGrantV1',grantSchema);}
const pending=new WeakMap();
function ensure(conn){
 if(!pending.has(conn))pending.set(conn,Promise.all([ensureModelIndexes(records(conn)),ensureModelIndexes(grants(conn))])
  .catch(error=>{pending.delete(conn);throw error;}));
 return pending.get(conn);
}
module.exports={records,grants,ensure,recordSchema,grantSchema};
