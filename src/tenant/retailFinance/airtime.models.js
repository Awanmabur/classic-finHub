'use strict';
const {Schema}=require('mongoose'),{currencyCodes}=require('../../config/currencies');
const {ensureModelIndexes}=require('../../config/ensureModelIndexes');
const O=Schema.Types.ObjectId,D=Schema.Types.Decimal128,UUID=/^[0-9a-f-]{36}$/;
const product=new Schema({
 tenantId:{type:O,required:true,immutable:true},branchId:{type:O,required:true,immutable:true},
 network:{type:String,required:true,maxlength:50,immutable:true},currency:{type:String,enum:currencyCodes,required:true,immutable:true},
 name:{type:String,required:true,maxlength:100,immutable:true},denominationMinor:{type:D,required:true,immutable:true},
 costMinor:{type:D,required:true,immutable:true},priceMinor:{type:D,required:true,immutable:true},
 status:{type:String,enum:['active','archived'],default:'active'},createdBy:{type:O,required:true,immutable:true}
},{timestamps:true,strict:'throw'});
product.index({branchId:1,status:1,network:1,createdAt:-1});
const inventory=new Schema({
 tenantId:{type:O,required:true,immutable:true},branchId:{type:O,required:true,immutable:true},
 network:{type:String,required:true,maxlength:50,immutable:true},currency:{type:String,enum:currencyCodes,required:true,immutable:true},
 costBalanceMinor:{type:D,required:true,default:'0'},revision:{type:Number,min:0,default:0},
 lastActivityAt:{type:Date,default:null}
},{timestamps:true,strict:'throw'});
inventory.index({branchId:1,network:1,currency:1},{unique:true});
const record=new Schema({
 tenantId:{type:O,required:true,immutable:true},branchId:{type:O,required:true,immutable:true},
 productId:{type:O,default:null,immutable:true},inventoryId:{type:O,required:true,immutable:true},
 type:{type:String,enum:['stock_purchase','sale'],required:true,immutable:true},
 idempotencyKey:{type:String,required:true,match:UUID,immutable:true},fingerprint:{type:String,required:true,immutable:true},
 network:{type:String,required:true,maxlength:50,immutable:true},currency:{type:String,enum:currencyCodes,required:true,immutable:true},
 phone:{type:String,default:'',maxlength:20,immutable:true},
 denominationMinor:{type:D,default:'0',immutable:true},costMinor:{type:D,required:true,immutable:true},
 retailMinor:{type:D,default:'0',immutable:true},profitMinor:{type:D,default:'0',immutable:true},
 accountId:{type:O,required:true,immutable:true},reference:{type:String,required:true,maxlength:120,immutable:true},
 batchId:{type:O,required:true,immutable:true},createdBy:{type:O,required:true,immutable:true},createdAt:{type:Date,default:Date.now,immutable:true}
},{strict:'throw',versionKey:false});
record.index({idempotencyKey:1},{unique:true});
record.index({branchId:1,type:1,createdAt:-1});record.index({inventoryId:1,createdAt:-1});
record.pre('save',function(next){next(this.isNew?null:new Error('Airtime evidence is immutable'));});
for(const op of ['updateOne','updateMany','replaceOne','findOneAndUpdate','findOneAndReplace','deleteOne','deleteMany','findOneAndDelete'])
 record.pre(op,function(next){next(new Error('Airtime evidence is immutable'));});
const correction=new Schema({
 tenantId:{type:O,required:true,immutable:true},branchId:{type:O,required:true,immutable:true},
 recordId:{type:O,required:true,immutable:true},inventoryId:{type:O,required:true,immutable:true},
 reversalBatchId:{type:O,required:true,immutable:true},
 type:{type:String,enum:['sale','stock_purchase'],required:true,immutable:true},
 currency:{type:String,enum:currencyCodes,required:true,immutable:true},
 amountMinor:{type:D,required:true,immutable:true},costMinor:{type:D,required:true,immutable:true},
 profitMinor:{type:D,required:true,immutable:true},
 reason:{type:String,required:true,maxlength:400,immutable:true},
 reference:{type:String,required:true,maxlength:120,immutable:true},
 createdBy:{type:O,required:true,immutable:true},createdAt:{type:Date,default:Date.now,immutable:true}
},{strict:'throw',versionKey:false});
correction.index({recordId:1},{unique:true});
correction.index({branchId:1,createdAt:-1});
correction.pre('save',function(next){next(this.isNew?null:new Error('Airtime corrections are immutable'));});
for(const op of ['updateOne','updateMany','replaceOne','findOneAndUpdate','findOneAndReplace','deleteOne','deleteMany','findOneAndDelete'])
 correction.pre(op,function(next){next(new Error('Airtime corrections are immutable'));});
const model=(conn,name,schema)=>conn.models[name]||conn.model(name,schema);
function models(conn){return {product:model(conn,'AirtimeProductV1',product),inventory:model(conn,'AirtimeInventoryV1',inventory),record:model(conn,'AirtimeRecordV1',record),correction:model(conn,'AirtimeCorrectionV1',correction)};}
const inflight=new WeakMap();
function ensure(conn){if(!inflight.has(conn))inflight.set(conn,Promise.all(Object.values(models(conn)).map(ensureModelIndexes)).catch(e=>{inflight.delete(conn);throw e;}));return inflight.get(conn);}
module.exports={models,ensure};
