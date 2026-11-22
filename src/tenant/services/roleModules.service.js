'use strict';
// Tenant-local, owner-managed role module defaults. These restrict which
// subscribed modules staff see; they NEVER create backend capabilities.
const mongoose=require('mongoose');
const {INVITABLE}=require('../../config/roles');
const {assignableModules,validateAssignments}=require('./moduleAccess.service');
const {tenantUserModel,auditEventModel}=require('../models');
const {ensureModelIndexes}=require('../../config/ensureModelIndexes');
const roleSchema=new mongoose.Schema({
 tenantId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
 role:{type:String,enum:INVITABLE,required:true,immutable:true},
 allowedModules:{type:[String],required:true,default:[]},
 revision:{type:Number,default:0,min:0},updatedBy:{type:mongoose.Schema.Types.ObjectId,required:true}
},{timestamps:true,strict:'throw'});
roleSchema.index({tenantId:1,role:1},{unique:true});
function model(conn){return conn.models.TenantRoleModulesV1||conn.model('TenantRoleModulesV1',roleSchema);}
function error(message,status=400){return Object.assign(new Error(message),{status});}
function roleName(role){if(!INVITABLE.includes(role))throw error('Choose an existing tenant staff role');return role;}
function defaultModules(tenant,role){return assignableModules(tenant,roleName(role));}
async function all(conn,tenant){
 const rows=await model(conn).find({tenantId:tenant._id}).select('role allowedModules revision').lean();
 const saved=new Map(rows.map(row=>[row.role,row]));
 return Object.fromEntries(INVITABLE.map(role=>{
  const entry=saved.get(role);
  return [role,{modules:entry?entry.allowedModules.filter(k=>defaultModules(tenant,role).includes(k)):defaultModules(tenant,role),revision:entry?.revision||0,custom:!!entry}];
 }));
}
async function forRole(conn,tenant,role){
 const name=roleName(role);
 const row=await model(conn).findOne({tenantId:tenant._id,role:name}).select('allowedModules').lean();
 return row?row.allowedModules.filter(k=>defaultModules(tenant,name).includes(k)):defaultModules(tenant,name);
}
async function save(conn,tenant,actor,input){
 if(actor?.role!=='Tenant Owner')throw error('Only the tenant owner can configure tenant role defaults',403);
 const role=roleName(String(input.role||'')),selected=validateAssignments(tenant,role,input.allowedModules);
 const revision=Number(input.revision);
 if(!Number.isSafeInteger(revision)||revision<0)throw error('Refresh role settings before saving',409);
 const applyExisting=input.applyExisting==='yes';
 if(input.applyExisting!==undefined&&input.applyExisting!==''&&input.applyExisting!=='yes')throw error('Invalid apply-existing preference');
 await ensureModelIndexes(model(conn));
 const session=await conn.startSession();
 try{
  await session.withTransaction(async()=>{
   const query={tenantId:tenant._id,role,revision};
   const updated=await model(conn).findOneAndUpdate(query,
    {$set:{allowedModules:selected,updatedBy:actor.id},$inc:{revision:1}},
    {new:true,session}).lean();
   if(!updated){
    if(revision!==0||await model(conn).exists({tenantId:tenant._id,role}).session(session))
      throw error('Role template changed. Refresh and retry',409);
    try{await model(conn).create([{tenantId:tenant._id,role,allowedModules:selected,updatedBy:actor.id,revision:1}],{session});}
    catch(e){if(e.code===11000)throw error('Role template changed. Refresh and retry',409);throw e;}
   }
   let changed=0;
   if(applyExisting){
    const result=await tenantUserModel(conn).updateMany({role,status:{$in:['active','disabled']}},
      {$set:{allowedModules:selected},$inc:{authVersion:1}},{session});
    changed=result.modifiedCount||0;
   }
   await auditEventModel(conn).create([{action:'staff.role_module_defaults.updated',actorId:actor.id,targetId:tenant._id,
    metadata:{role,modules:selected,applyExisting,staffUpdated:changed,revision:revision+1}}],{session});
  });
 }finally{await session.endSession();}
 return {role,applyExisting};
}
module.exports={model,all,forRole,save,defaultModules};
