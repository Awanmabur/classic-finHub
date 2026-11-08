'use strict';
const {Schema}=require('mongoose'),O=Schema.Types.ObjectId;
const policySchema=new Schema({
 tenantId:{type:O,required:true,immutable:true},scopeKey:{type:String,required:true,immutable:true,match:/^(?:tenant|branch_[a-f0-9]{24})$/},branchId:{type:O,default:null,immutable:true},
 createdBy:{type:O,required:true,immutable:true},connectedBy:{type:O,default:null},connectedAuthVersion:{type:Number,default:null},connectedAt:{type:Date,default:null},refreshEncrypted:{type:String,select:false,maxlength:12000},
 closingTime:{type:String,default:'18:00',match:/^(?:[01]\d|2[0-3]):[0-5]\d$/},timezone:{type:String,default:'Africa/Juba',maxlength:80},autoEnabled:{type:Boolean,default:true},lastScheduledDay:{type:String,default:''},
 requestedAt:{type:Date,default:null},requestedBy:{type:O,default:null},nextAttemptAt:{type:Date,default:null},leaseToken:{type:String,default:null},leaseUntil:{type:Date,default:null},
 lastDigest:{type:String,default:'',match:/^(?:|[a-f0-9]{64})$/},lastBackupAt:{type:Date,default:null},lastCheckedAt:{type:Date,default:null},lastResult:{type:String,enum:['never','queued','complete','no_changes','error'],default:'never'},lastTarget:{type:String,enum:['','drive','fallback'],default:''},failureCode:{type:String,default:'',maxlength:80},revision:{type:Number,default:0}
},{strict:'throw',timestamps:true});
policySchema.index({scopeKey:1},{unique:true});policySchema.index({requestedAt:1,nextAttemptAt:1,leaseUntil:1});
const archiveSchema=new Schema({
 policyId:{type:O,required:true,immutable:true},tenantId:{type:O,required:true,immutable:true},scopeKey:{type:String,required:true,immutable:true},digest:{type:String,required:true,immutable:true,match:/^[a-f0-9]{64}$/},
 filename:{type:String,required:true,immutable:true,match:/^[a-f0-9]{24}-[a-f0-9]{64}\.cfhbackup$/},size:{type:Number,required:true,immutable:true},recordCount:{type:Number,required:true,immutable:true},
 driveFileId:{type:String,default:null,maxlength:200},driveUploadedAt:{type:Date,default:null},failureCode:{type:String,default:'',maxlength:80},createdAt:{type:Date,default:Date.now,immutable:true}
},{strict:'throw',versionKey:false});
archiveSchema.index({policyId:1,digest:1},{unique:true});archiveSchema.index({policyId:1,createdAt:-1});
function models(conn){return {policy:conn.models.TenantBackupPolicyV1||conn.model('TenantBackupPolicyV1',policySchema),archive:conn.models.TenantBackupArchiveV1||conn.model('TenantBackupArchiveV1',archiveSchema)};}
const ready=new WeakMap();function ensure(conn){if(!ready.has(conn))ready.set(conn,Promise.all(Object.values(models(conn)).map(Model=>Model.createIndexes())).catch(error=>{ready.delete(conn);throw error;}));return ready.get(conn);}
module.exports={models,ensure};
