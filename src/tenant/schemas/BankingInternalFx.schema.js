'use strict';
const {Schema}=require('mongoose');
const {ensureModelIndexes}=require('../../config/ensureModelIndexes');
const {currencyCodes}=require('../../config/currencies');
const O=Schema.Types.ObjectId,D=Schema.Types.Decimal128;
const schema=new Schema({
 tenantId:{type:O,required:true,immutable:true},branchId:{type:O,required:true,immutable:true},
 createdBy:{type:O,required:true,immutable:true},
 idempotencyKey:{type:String,required:true,immutable:true},
 evidenceReference:{type:String,required:true,maxlength:120,immutable:true},
 customerId:{type:O,required:true,immutable:true},
 sourceAccountId:{type:O,required:true,immutable:true},
 destinationAccountId:{type:O,required:true,immutable:true},
 sourceCurrency:{type:String,enum:currencyCodes,required:true,immutable:true},
 destinationCurrency:{type:String,enum:currencyCodes,required:true,immutable:true},
 sourceAmountMinor:{type:D,required:true,immutable:true},
 destinationAmountMinor:{type:D,required:true,immutable:true},
 rateId:{type:O,required:true,immutable:true},rateSide:{type:String,enum:['buy','sell'],required:true,immutable:true},
 rateDecimal:{type:String,required:true,immutable:true},rateVersion:{type:Number,required:true,immutable:true},
 journalBatchId:{type:O,required:true,immutable:true},journalIds:{type:[O],required:true,immutable:true},
 state:{type:String,enum:['posted_internal'],default:'posted_internal',required:true,immutable:true},
 postedAt:{type:Date,required:true,immutable:true}
},{strict:'throw',versionKey:false,timestamps:{createdAt:true,updatedAt:false}});
for(const op of ['updateOne','updateMany','replaceOne','findOneAndUpdate','findOneAndReplace','deleteOne','deleteMany','findOneAndDelete'])
 schema.pre(op,function(next){next(new Error('Posted Banking FX evidence is append-only'));});
schema.pre('save',function(next){next(this.isNew?null:new Error('Posted Banking FX evidence is append-only'));});
schema.index({tenantId:1,idempotencyKey:1},{unique:true});
schema.index({tenantId:1,branchId:1,evidenceReference:1},{unique:true});
schema.index({tenantId:1,branchId:1,postedAt:-1,_id:-1});
const model=conn=>conn.models.BankingInternalFxV1||conn.model('BankingInternalFxV1',schema);
const pending=new WeakMap();
function ensure(conn){if(!pending.has(conn))pending.set(conn,ensureModelIndexes(model(conn)).catch(e=>{pending.delete(conn);throw e;}));return pending.get(conn);}
module.exports={schema,model,ensure};
