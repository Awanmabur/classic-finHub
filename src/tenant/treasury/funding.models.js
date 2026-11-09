'use strict';
const {ensureModelIndexes}=require('../../config/ensureModelIndexes');
const {Schema}=require('mongoose');
const {currencyCodes}=require('../../config/currencies');
const O=Schema.Types.ObjectId;
const schema=new Schema({
 tenantId:{type:O,required:true,immutable:true},branchId:{type:O,required:true,immutable:true},
 sourceAccountId:{type:O,required:true,immutable:true},destinationAccountId:{type:O,required:true,immutable:true},
 currency:{type:String,enum:currencyCodes,required:true,immutable:true},amountMinor:{type:Schema.Types.Decimal128,required:true,immutable:true},
 requestedBy:{type:O,required:true,immutable:true},requestedRole:{type:String,required:true,immutable:true},requestedAuthVersion:{type:Number,required:true,immutable:true,min:0},
 operatingActorId:{type:O,required:true,immutable:true},operatingRole:{type:String,required:true,immutable:true},operatingAuthVersion:{type:Number,required:true,immutable:true,min:0},
 idempotencyKey:{type:String,required:true,immutable:true,match:/^[a-f0-9-]{36}$/i},fingerprint:{type:String,required:true,immutable:true,match:/^[a-f0-9]{64}$/},
 evidenceReference:{type:String,required:true,maxlength:120,immutable:true},note:{type:String,required:true,maxlength:400,immutable:true},
 status:{type:String,enum:['pending_review','posted','rejected'],required:true,default:'pending_review'},
 reviewedBy:{type:O,default:null},reviewedAt:{type:Date,default:null},reviewNote:{type:String,maxlength:400,default:''},
 batchId:{type:O,default:null},journalIds:{type:[O],default:[]},revision:{type:Number,default:0,min:0},
 createdAt:{type:Date,default:Date.now,immutable:true}
},{strict:'throw',versionKey:false});
schema.index({idempotencyKey:1},{unique:true});
schema.index({tenantId:1,branchId:1,status:1,createdAt:-1});
schema.index({sourceAccountId:1,createdAt:-1});schema.index({destinationAccountId:1,createdAt:-1});
const model=conn=>conn.models.TreasuryFundingV1||conn.model('TreasuryFundingV1',schema);
const ready=new WeakMap();
function ensureIndexes(conn){if(!ready.has(conn))ready.set(conn,ensureModelIndexes(model(conn)).catch(error=>{ready.delete(conn);throw error;}));return ready.get(conn);}
module.exports={model,ensureIndexes,schema};
