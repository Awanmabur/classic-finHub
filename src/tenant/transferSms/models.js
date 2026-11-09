'use strict';
const {ensureModelIndexes}=require('../../config/ensureModelIndexes');
const {Schema}=require('mongoose');
const O=Schema.Types.ObjectId;
const schema=new Schema({
 tenantId:{type:O,required:true,immutable:true},branchId:{type:O,required:true,immutable:true},executionId:{type:O,required:true,immutable:true},sourceId:{type:O,required:true,immutable:true},
 recipientMasked:{type:String,required:true,maxlength:20},payloadEncrypted:{type:String,select:false,maxlength:10000},
 state:{type:String,enum:['pending','retry','processing','accepted','dead','not_configured','suppressed','uncertain'],required:true},
 attempts:{type:Number,default:0,min:0},redrives:{type:Number,default:0,min:0,max:3},lastRequeuedAt:{type:Date,default:null},availableAt:{type:Date,default:Date.now},leaseToken:{type:String,default:null,select:false},leaseUntil:{type:Date,default:null},
 failureCode:{type:String,default:null,maxlength:80},acceptedMessageId:{type:String,default:null,maxlength:80},providerState:{type:String,default:null,maxlength:40},acceptedAt:{type:Date,default:null},revision:{type:Number,default:0,min:0}
},{strict:'throw',timestamps:true});
schema.index({executionId:1},{unique:true});schema.index({state:1,availableAt:1});schema.index({state:1,leaseUntil:1});schema.index({branchId:1,createdAt:-1});
function model(conn){return conn.models.TransferSmsDeliveryV1||conn.model('TransferSmsDeliveryV1',schema);}
const ready=new WeakMap();function ensureIndexes(conn){if(!ready.has(conn))ready.set(conn,ensureModelIndexes(model(conn)).catch(error=>{ready.delete(conn);throw error;}));return ready.get(conn);}
module.exports={model,ensureIndexes,schema};
