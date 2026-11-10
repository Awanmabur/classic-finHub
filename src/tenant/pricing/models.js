'use strict';
const mongoose=require('mongoose');
const {ensureModelIndexes}=require('../../config/ensureModelIndexes');
const operations=Object.freeze([
 {key:'mobile_money.cash_in',label:'Mobile Money — Cash-in',moduleKey:'mobile_money'},
 {key:'mobile_money.cash_out',label:'Mobile Money — Cash-out',moduleKey:'mobile_money'},
 {key:'money_transfer.send',label:'Money Transfer — Send',moduleKey:'money_transfer'},
 {key:'banking.deposit',label:'Banking — Deposit',moduleKey:'banking'},
 {key:'banking.withdrawal',label:'Banking — Withdrawal',moduleKey:'banking'},
 {key:'banking.transfer',label:'Banking — Account transfer',moduleKey:'banking'},
 {key:'forex.buy',label:'Forex — Buy',moduleKey:'forex'},
 {key:'forex.sell',label:'Forex — Sell',moduleKey:'forex'},
 {key:'forex.quote',label:'Forex — Quote',moduleKey:'forex'}
].map(Object.freeze));
const schema=new mongoose.Schema({
 tenantId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
 branchId:{type:mongoose.Schema.Types.ObjectId,default:null,immutable:true},
 operation:{type:String,enum:operations.map(row=>row.key),required:true,immutable:true},
 currency:{type:String,enum:require('../../config/currencies').forexCurrencyCodes,required:true,immutable:true},
 network:{type:String,enum:['',...require('../../config/mobileNetworks').networks],default:'',immutable:true},
 fixedFeeMinor:{type:String,required:true,match:/^\d{1,11}$/,default:'0'},
 feeBps:{type:Number,required:true,min:0,max:10000,default:0,validate:Number.isSafeInteger},
 fixedCostMinor:{type:String,required:true,match:/^\d{1,11}$/,default:'0'},
 costBps:{type:Number,required:true,min:0,max:10000,default:0,validate:Number.isSafeInteger},
 enabled:{type:Boolean,required:true,default:true},
 revision:{type:Number,required:true,min:0,default:0,validate:Number.isSafeInteger},
 createdBy:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
 updatedBy:{type:mongoose.Schema.Types.ObjectId,required:true}
},{timestamps:true,strict:'throw'});
schema.index({tenantId:1,branchId:1,operation:1,currency:1,network:1},{unique:true});
function model(conn){return conn.models.OperationPricingPolicyV1||conn.model('OperationPricingPolicyV1',schema);}
const ready=new WeakMap();
async function ensure(conn){
 if(!ready.has(conn))ready.set(conn,Promise.all([ensureModelIndexes(model(conn)),ensureModelIndexes(require('../models').auditEventModel(conn))]).catch(error=>{ready.delete(conn);throw error;}));
 await ready.get(conn);
}
module.exports={model,ensure,schema,operations};
