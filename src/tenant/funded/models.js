'use strict';
const {ensureModelIndexes}=require('../../config/ensureModelIndexes');
const {Schema}=require('mongoose');
const O=Schema.Types.ObjectId;
const executionSchema=new Schema({
 sourceType:{type:String,enum:['banking','forex','money_transfer'],required:true,immutable:true},
 sourceId:{type:O,required:true,immutable:true},sourceReference:{type:String,required:true,immutable:true,maxlength:120},
 action:{type:String,enum:['banking','forex','transfer_collect','transfer_payout'],required:true,immutable:true},
 branchId:{type:O,required:true,immutable:true},createdBy:{type:O,required:true,immutable:true},
 idempotencyKey:{type:String,required:true,immutable:true,match:/^[a-f0-9-]{36}$/i},
 fingerprint:{type:String,required:true,immutable:true,match:/^[a-f0-9]{64}$/},
 sourceFingerprint:{type:String,required:true,immutable:true,match:/^[a-f0-9]{64}$/},
 sourceSnapshot:{type:Schema.Types.Mixed,required:true,immutable:true},
 accounts:{type:new Schema({cashAccountId:{type:O,default:null},foreignAccountId:{type:O,default:null},settlementAccountId:{type:O,default:null},collectionAccountId:{type:O,default:null},clearingAccountId:{type:O,default:null},payoutAccountId:{type:O,default:null}},{_id:false,strict:'throw'}),required:true,immutable:true},
 collectionExecutionId:{type:O,default:null,immutable:true},verificationDigest:{type:String,default:null,immutable:true,select:false},
 evidenceReference:{type:String,required:true,maxlength:120,immutable:true},note:{type:String,required:true,maxlength:400,immutable:true},
 verificationInfo:{type:new Schema({receiverNameCheck:{type:String,maxlength:120,default:''},identityDocument:{type:String,maxlength:80,default:''}},{_id:false,strict:'throw'}),default:()=>({}),immutable:true},
 status:{type:String,enum:['pending_review','posted_manual','rejected'],required:true,default:'pending_review'},
 activeKey:{type:String,maxlength:100},reviewedBy:{type:O,default:null},reviewedAt:{type:Date,default:null},reviewNote:{type:String,maxlength:400,default:''},
 journalIds:{type:[O],default:[]},
 pinLookupVersion:{type:String,enum:['receiver_v1','sender_v2','sender_destination_v3'],default:'receiver_v1'},
 pinHash:{type:String,select:false,match:/^[a-f0-9]{64}$/},pinEncrypted:{type:String,select:false,maxlength:300},pinShownAt:{type:Date,default:null},
 revision:{type:Number,default:0,min:0}
},{strict:'throw',timestamps:true});
executionSchema.index({idempotencyKey:1},{unique:true});
executionSchema.index({activeKey:1},{unique:true,partialFilterExpression:{activeKey:{$type:'string'}}});
executionSchema.index({pinHash:1},{unique:true,partialFilterExpression:{pinHash:{$type:'string'}}});
executionSchema.index({branchId:1,createdAt:-1,_id:-1});executionSchema.index({sourceType:1,sourceId:1,createdAt:-1});
executionSchema.index({sourceType:1,status:1,reviewedAt:-1,branchId:1});
executionSchema.index({status:1,createdAt:1});executionSchema.index({createdBy:1,createdAt:-1});
const verificationSchema=new Schema({
 collectionExecutionId:{type:O,required:true,immutable:true},branchId:{type:O,required:true,immutable:true},createdBy:{type:O,required:true,immutable:true},
 tokenHash:{type:String,required:true,immutable:true,match:/^[a-f0-9]{64}$/},expiresAt:{type:Date,required:true,immutable:true},consumedAt:{type:Date,default:null},
 lookupVersion:{type:String,enum:['receiver_v1','sender_v2','sender_destination_v3'],default:'receiver_v1',immutable:true},lookupPhone:{type:String,maxlength:16,immutable:true},
 receiverName:{type:String,required:true,maxlength:120,immutable:true},receiverPhone:{type:String,required:true,maxlength:16,immutable:true},
 receiverNameCheck:{type:String,maxlength:120,default:'',immutable:true},identityDocument:{type:String,maxlength:80,default:'',immutable:true}
},{strict:'throw',timestamps:true});
verificationSchema.index({tokenHash:1},{unique:true});verificationSchema.index({expiresAt:1},{expireAfterSeconds:0});
function models(conn){return {execution:conn.models.FundedExecutionV1||conn.model('FundedExecutionV1',executionSchema),verification:conn.models.ManualPayoutVerificationV1||conn.model('ManualPayoutVerificationV1',verificationSchema)};}
const ready=new WeakMap();
function ensureIndexes(conn){if(!ready.has(conn))ready.set(conn,Promise.all(Object.values(models(conn)).map(ensureModelIndexes)).catch(error=>{ready.delete(conn);throw error;}));return ready.get(conn);}
module.exports={models,ensureIndexes,executionSchema,verificationSchema};
