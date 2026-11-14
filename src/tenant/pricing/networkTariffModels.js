'use strict';
const mongoose=require('mongoose');
const {ensureModelIndexes}=require('../../config/ensureModelIndexes');
const {networks}=require('../../config/mobileNetworks');
const bands=new mongoose.Schema({
 minMinor:{type:String,required:true,match:/^(?:0|[1-9][0-9]{0,17})$/},
 maxMinor:{type:String,required:true,match:/^(?:0|[1-9][0-9]{0,17})$/},
 rate:{kind:{type:String,enum:['flat','basis_points'],required:true},
  value:{type:String,required:true,match:/^(?:0|[1-9][0-9]{0,17})$/}}
},{_id:false,strict:'throw'});
const schema=new mongoose.Schema({
 tenantId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
 branchId:{type:mongoose.Schema.Types.ObjectId,default:null,immutable:true},
 network:{type:String,enum:networks,required:true,immutable:true},
 currency:{type:String,enum:require('../../config/currencies').currencyCodes,required:true,immutable:true},
 operation:{type:String,enum:require('./networkTariffs').OPERATIONS,required:true,immutable:true},
 scheduleKind:{type:String,enum:require('./networkTariffs').SCHEDULE_KINDS,required:true,immutable:true},
 version:{type:Number,min:1,required:true,immutable:true},
 status:{type:String,enum:['draft','approved','retired'],default:'draft'},
 tiers:{type:[bands],required:true},
 evidenceReference:{type:String,required:true,maxlength:350},
 effectiveFrom:{type:Date,required:true,immutable:true},
 expiresAt:{type:Date,default:null,immutable:true},
 createdBy:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
 approvedBy:{type:mongoose.Schema.Types.ObjectId,default:null},
 approvedAt:{type:Date,default:null},
 retiredBy:{type:mongoose.Schema.Types.ObjectId,default:null},
 retiredAt:{type:Date,default:null},
 revision:{type:Number,required:true,default:0,min:0}
},{timestamps:true,strict:'throw'});
schema.index({tenantId:1,branchId:1,network:1,currency:1,operation:1,scheduleKind:1,version:1},{unique:true});
schema.index({tenantId:1,status:1,network:1,operation:1,effectiveFrom:-1});
function model(conn){return conn.models.AgentTariffScheduleV1||conn.model('AgentTariffScheduleV1',schema);}
const ready=new WeakMap();
async function ensure(conn){
 if(!ready.has(conn))ready.set(conn,ensureModelIndexes(model(conn)).catch(e=>{ready.delete(conn);throw e;}));
 await ready.get(conn);
}
module.exports={schema,model,ensure};
