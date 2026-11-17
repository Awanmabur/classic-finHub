'use strict';
const {Schema}=require('mongoose');
const {currencyCodes}=require('../../config/currencies');
const {ensureModelIndexes}=require('../../config/ensureModelIndexes');
const O=Schema.Types.ObjectId,D=Schema.Types.Decimal128;
const schema=new Schema({
 tenantId:{type:O,required:true,immutable:true},
 transferId:{type:O,required:true,immutable:true},
 branchId:{type:O,required:true,immutable:true},
 destinationBranchId:{type:O,required:true,immutable:true},
 sourceCashAccountId:{type:O,required:true,immutable:true},
 destinationCashAccountId:{type:O,required:true,immutable:true},
 currency:{type:String,enum:currencyCodes,required:true,immutable:true},
 amountMinor:{type:D,required:true,immutable:true},
 requestedBy:{type:O,required:true,immutable:true},
 idempotencyKey:{type:String,required:true,immutable:true,match:/^[a-f0-9-]{36}$/i},
 evidenceReference:{type:String,required:true,immutable:true,maxlength:120},
 note:{type:String,required:true,immutable:true,maxlength:400},
 status:{type:String,enum:['pending_receiver','pending_review','return_pending','return_verified','returned','posted'],default:'pending_receiver',required:true},
 activeKey:{type:String,maxlength:100},
 receivedBy:{type:O,default:null},receiverConfirmedAt:{type:Date,default:null},
 receiverNote:{type:String,maxlength:400,default:null},
 reservedAt:{type:Date,default:null},
 returnReference:{type:String,maxlength:120,default:null},
 returnNote:{type:String,maxlength:400,default:null},
 returnConfirmedBy:{type:O,default:null},
 returnConfirmedAt:{type:Date,default:null},
 returnApprovedBy:{type:O,default:null},
 returnApprovedAt:{type:Date,default:null},
 reviewedBy:{type:O,default:null},
 reviewedAt:{type:Date,default:null},
 reviewNote:{type:String,maxlength:400,default:null},
 senderHandoverReference:{type:String,maxlength:120,default:null},
 receiverReceiptReference:{type:String,maxlength:120,default:null},
 originBatchId:{type:O,default:null},
 destinationBatchId:{type:O,default:null},
 revision:{type:Number,default:0,min:0}
},{strict:'throw',timestamps:true,versionKey:false});
schema.index({idempotencyKey:1},{unique:true,name:'unique_branch_cash_settlement_retry'});
schema.index({activeKey:1},{unique:true,partialFilterExpression:{activeKey:{$type:'string'}},
 name:'one_pending_or_posted_branch_cash_reimbursement'});
schema.index({branchId:1,createdAt:-1});
schema.index({tenantId:1,branchId:1,evidenceReference:1},
 {unique:true,name:'unique_sender_handover_receipt_per_branch'});
schema.index({tenantId:1,returnReference:1},
 {unique:true,partialFilterExpression:{returnReference:{$type:'string'}},
 name:'unique_actual_sender_return_receipt'});
schema.index({tenantId:1,receiverReceiptReference:1},
 {unique:true,partialFilterExpression:{receiverReceiptReference:{$type:'string'}},
  name:'unique_actual_receiving_cashier_receipt'});
function model(conn){return conn.models.InterbranchCashReimbursementV1||
 conn.model('InterbranchCashReimbursementV1',schema);}
const ready=new WeakMap();
function ensure(conn){
 if(!ready.has(conn))ready.set(conn,ensureModelIndexes(model(conn))
  .catch(error=>{ready.delete(conn);throw error;}));
 return ready.get(conn);
}
module.exports={model,ensure,schema};
