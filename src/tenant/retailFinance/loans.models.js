'use strict';
const {Schema}=require('mongoose'),{currencyCodes}=require('../../config/currencies');
const {ensureModelIndexes}=require('../../config/ensureModelIndexes');
const O=Schema.Types.ObjectId,D=Schema.Types.Decimal128,UUID=/^[0-9a-f-]{36}$/;
const product=new Schema({
 tenantId:{type:O,required:true,immutable:true},branchId:{type:O,required:true,immutable:true},
 name:{type:String,required:true,maxlength:100,immutable:true},currency:{type:String,enum:currencyCodes,required:true,immutable:true},
 flatInterestBps:{type:Number,min:0,max:10000,required:true,immutable:true},termDays:{type:Number,min:1,max:730,required:true,immutable:true},
 minMinor:{type:D,required:true,immutable:true},maxMinor:{type:D,required:true,immutable:true},
 status:{type:String,enum:['active','archived'],default:'active'},createdBy:{type:O,required:true,immutable:true}
},{timestamps:true,strict:'throw'});
product.index({branchId:1,status:1,createdAt:-1});
const loan=new Schema({
 tenantId:{type:O,required:true,immutable:true},branchId:{type:O,required:true,immutable:true},
 customerId:{type:O,required:true,immutable:true},productId:{type:O,required:true,immutable:true},
 applicationRef:{type:String,required:true,immutable:true},requestKey:{type:String,required:true,match:UUID,immutable:true},requestHash:{type:String,required:true,immutable:true},
 principalMinor:{type:D,required:true,immutable:true},interestMinor:{type:D,required:true,immutable:true},
 principalOutstandingMinor:{type:D,required:true},interestOutstandingMinor:{type:D,required:true},
 currency:{type:String,enum:currencyCodes,required:true,immutable:true},
 dueAt:{type:Date,required:true},reason:{type:String,maxlength:400,required:true,immutable:true},
 status:{type:String,enum:['requested','approved','declined','active','paid'],default:'requested'},
 requestedBy:{type:O,required:true,immutable:true},reviewedBy:{type:O,default:null},
 reviewedAt:{type:Date,default:null},reviewReason:{type:String,maxlength:400,default:''},
 disbursedAt:{type:Date,default:null},disbursedBy:{type:O,default:null},disbursementRef:{type:String,maxlength:120,default:''},
 sourceAccountId:{type:O,default:null},disbursementBatchId:{type:O,default:null},
 revision:{type:Number,default:0,min:0}
},{timestamps:true,strict:'throw'});
loan.index({requestKey:1},{unique:true});loan.index({applicationRef:1},{unique:true});
loan.index({branchId:1,status:1,dueAt:1});loan.index({customerId:1,createdAt:-1});
const payment=new Schema({
 tenantId:{type:O,required:true,immutable:true},branchId:{type:O,required:true,immutable:true},loanId:{type:O,required:true,immutable:true},
 idempotencyKey:{type:String,required:true,match:UUID,immutable:true},fingerprint:{type:String,required:true,immutable:true},
 amountMinor:{type:D,required:true,immutable:true},principalMinor:{type:D,required:true,immutable:true},
 interestMinor:{type:D,required:true,immutable:true},currency:{type:String,enum:currencyCodes,required:true,immutable:true},
 accountId:{type:O,required:true,immutable:true},reference:{type:String,required:true,maxlength:120,immutable:true},
 batchId:{type:O,required:true,immutable:true},createdBy:{type:O,required:true,immutable:true},createdAt:{type:Date,default:Date.now,immutable:true}
},{strict:'throw',versionKey:false});
payment.index({idempotencyKey:1},{unique:true});payment.index({loanId:1,createdAt:-1});
function immutable(schema){
 schema.pre('save',function(next){next(this.isNew?null:new Error('Loan payment evidence is immutable'));});
 for(const op of ['updateOne','updateMany','replaceOne','findOneAndUpdate','findOneAndReplace','deleteOne','deleteMany','findOneAndDelete'])
  schema.pre(op,function(next){next(new Error('Loan payments are immutable'));});
}
immutable(payment);
const model=(conn,name,schema)=>conn.models[name]||conn.model(name,schema);
function models(conn){return {product:model(conn,'LoanProductV1',product),loan:model(conn,'LoanCaseV1',loan),payment:model(conn,'LoanPaymentV1',payment)};}
const inflight=new WeakMap();
function ensure(conn){if(!inflight.has(conn))inflight.set(conn,Promise.all(Object.values(models(conn)).map(ensureModelIndexes)).catch(e=>{inflight.delete(conn);throw e;}));return inflight.get(conn);}
module.exports={models,ensure};
