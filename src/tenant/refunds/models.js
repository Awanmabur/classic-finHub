'use strict';
const {Schema}=require('mongoose');
const {ensureModelIndexes}=require('../../config/ensureModelIndexes');
const O=Schema.Types.ObjectId,D=Schema.Types.Decimal128;
const refund=new Schema({
 tenantId:{type:O,required:true,immutable:true},sourceId:{type:O,required:true,immutable:true},
 collectionExecutionId:{type:O,required:true,immutable:true},branchId:{type:O,required:true,immutable:true},
 requestedBy:{type:O,required:true,immutable:true},cashAccountId:{type:O,required:true,immutable:true},
 currency:{type:String,required:true,immutable:true},principalMinor:{type:D,required:true,immutable:true},
 feeMinor:{type:D,required:true,immutable:true},
 idempotencyKey:{type:String,required:true,immutable:true,match:/^[0-9a-f-]{36}$/i},
 reason:{type:String,required:true,minlength:12,maxlength:400,immutable:true},
 senderPhone:{type:String,required:true,maxlength:16,immutable:true},
 evidenceReference:{type:String,required:true,minlength:8,maxlength:120,immutable:true},
 evidenceDigest:{type:String,required:true,match:/^[0-9a-f]{64}$/,immutable:true},
 status:{type:String,enum:['pending_review','rejected','posted_refund'],required:true,default:'pending_review'},
 activeKey:{type:String,maxlength:100},
 reviewedBy:{type:O,default:null},reviewedAt:{type:Date,default:null},
 reviewNote:{type:String,maxlength:400,default:null},
 reversalBatchId:{type:O,default:null},journalIds:{type:[O],default:[]},
 revision:{type:Number,default:0,min:0}
},{strict:'throw',timestamps:true,versionKey:false});
refund.index({tenantId:1,sourceId:1,createdAt:-1});
refund.index({idempotencyKey:1},{unique:true,name:'unique_refund_request_retry'});
refund.index({activeKey:1},{unique:true,partialFilterExpression:{activeKey:{$type:'string'}},name:'single_pending_or_posted_cash_refund'});
refund.index({branchId:1,status:1,createdAt:-1});
function model(conn){return conn.models.ManualTransferRefundV1||conn.model('ManualTransferRefundV1',refund);}
const ready=new WeakMap();
function ensure(conn){
 if(!ready.has(conn))ready.set(conn,ensureModelIndexes(model(conn)).catch(error=>{ready.delete(conn);throw error;}));
 return ready.get(conn);
}
module.exports={model,ensure,schema:refund};
