'use strict';
const mongoose=require('mongoose');
const {ensureModelIndexes}=require('../../config/ensureModelIndexes');
const schema=new mongoose.Schema({
 tenantId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
 branchId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
 walletAccountId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
 network:{type:String,enum:require('../../config/mobileNetworks').networks,required:true,immutable:true},
 currency:{type:String,enum:require('../../config/currencies').currencyCodes,required:true,immutable:true},
 providerReference:{type:String,required:true,maxlength:120,immutable:true},
 statementEvidence:{type:String,required:true,maxlength:350,immutable:true},
 creditedAt:{type:Date,required:true,immutable:true},
 amountMinor:{type:String,required:true,match:/^[1-9][0-9]{0,17}$/,immutable:true},
 status:{type:String,enum:['pending_review','posted','rejected'],default:'pending_review'},
 createdBy:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
 reviewedBy:{type:mongoose.Schema.Types.ObjectId,default:null},
 reviewedAt:{type:Date,default:null},
 reviewNote:{type:String,maxlength:400,default:''},
 journalBatchId:{type:mongoose.Schema.Types.ObjectId,default:null}
},{timestamps:true,strict:'throw'});
schema.index({tenantId:1,walletAccountId:1,network:1,providerReference:1},{unique:true});
schema.index({tenantId:1,branchId:1,status:1,createdAt:-1});
function model(conn){return conn.models.AgentCommissionPayoutV1||conn.model('AgentCommissionPayoutV1',schema);}
const ready=new WeakMap();
async function ensure(conn){if(!ready.has(conn))ready.set(conn,ensureModelIndexes(model(conn)).catch(e=>{ready.delete(conn);throw e;}));await ready.get(conn);}
module.exports={model,ensure};
