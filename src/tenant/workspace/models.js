'use strict';
const {ensureModelIndexes}=require('../../config/ensureModelIndexes');
const mongoose=require('mongoose');
const nested=definition=>new mongoose.Schema(definition,{_id:false,strict:'throw'});
const configSchema=new mongoose.Schema({
 tenantId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
 revision:{type:Number,required:true,min:0,default:0},
 profile:{type:nested({name:{type:String,maxlength:150},legalName:{type:String,maxlength:150},owner:{type:String,maxlength:150},
  ownerEmail:{type:String,maxlength:254},supportPhone:{type:String,maxlength:40},country:{type:String,maxlength:80},timezone:{type:String,maxlength:80},defaultCurrency:{type:String,enum:['UGX','KES','USD','SSP']}}),default:()=>({})},
 landing:{type:nested({headline:{type:String,maxlength:200},subtitle:{type:String,maxlength:1000},services:{type:[String],default:[]},
  publishedAt:Date,publishedBy:mongoose.Schema.Types.ObjectId,published:{type:nested({name:String,headline:String,subtitle:String,services:[String],
   sections:[nested({name:String,description:String,order:Number})],primary:String,secondary:String,supportPhone:String}),default:undefined}}),default:()=>({})},
 branding:{type:nested({theme:{type:String,maxlength:80},primary:{type:String,match:/^#[a-fA-F0-9]{6}$/},secondary:{type:String,match:/^#[a-fA-F0-9]{6}$/},
  logoStatus:{type:String,maxlength:80},receiptNote:{type:String,maxlength:500},prefix:{type:String,match:/^[A-Z0-9-]{2,12}$/},template:{type:String,maxlength:80}}),default:()=>({})},
 updatedBy:{type:mongoose.Schema.Types.ObjectId,required:true}
},{timestamps:true,strict:'throw'});
configSchema.index({tenantId:1},{unique:true});
const entrySchema=new mongoose.Schema({
 tenantId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
 kind:{type:String,required:true,immutable:true,enum:['landing_section','kyc_field','compliance_rule','integration','notification_rule','data_job','backup_request']},
 name:{type:String,required:true,maxlength:150},description:{type:String,maxlength:2000,default:''},
 type:{type:String,maxlength:80,default:''},status:{type:String,required:true,enum:['draft','published','hidden','enabled','disabled','archived','requested','rejected','completed']},
 archivedStatus:{type:String,enum:['draft','published','hidden','enabled','disabled','requested','rejected','completed',null],default:null},
 order:{type:Number,min:0,max:1000,default:0},required:{type:Boolean,default:false},options:{type:[String],default:[]},
 channel:{type:String,maxlength:80,default:''},riskLevel:{type:String,enum:['','Low','Medium','High','Critical'],default:''},
 records:{type:Number,min:0,default:0},result:{type:String,maxlength:500,default:''},
 revision:{type:Number,min:0,default:0},createdBy:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},updatedBy:{type:mongoose.Schema.Types.ObjectId,required:true}
},{timestamps:true,strict:'throw'});
entrySchema.index({tenantId:1,kind:1,createdAt:-1});
function models(conn){return {
 config:conn.models.TenantWorkspaceConfigV1||conn.model('TenantWorkspaceConfigV1',configSchema),
 entry:conn.models.TenantWorkspaceEntryV1||conn.model('TenantWorkspaceEntryV1',entrySchema)
};}
const indexes=new WeakMap();
async function ensure(conn){
 if(!indexes.has(conn)){
  const {config,entry}=models(conn);
  const task=Promise.all([ensureModelIndexes(config),ensureModelIndexes(entry),ensureModelIndexes(require('../models').auditEventModel(conn))])
   .catch(error=>{indexes.delete(conn);throw error;});
  indexes.set(conn,task);
 }
 await indexes.get(conn);
}
module.exports={models,ensure,configSchema,entrySchema};
