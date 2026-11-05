'use strict';
const mongoose=require('mongoose');
const O=mongoose.Schema.Types.ObjectId;
// Tenant-local immutable message content. Email status records provider acceptance,
// NEVER recipient delivery. No arbitrary third-party addresses are stored here.
const schema=new mongoose.Schema({
 dedupeKey:{type:String,required:true,immutable:true,maxlength:160},
 recipientId:{type:O,required:true,immutable:true},senderId:{type:O,required:true,immutable:true},
 branchId:{type:String,default:null,immutable:true},
 templateCode:{type:String,required:true,immutable:true},templateVersion:{type:Number,required:true,immutable:true,min:1},
 subject:{type:String,required:true,immutable:true,maxlength:120},
 body:{type:String,required:true,immutable:true,maxlength:1000},
 source:{type:String,enum:['manual','approval_request'],default:'manual',immutable:true},
 sourceId:{type:O,default:null,immutable:true},
 readAt:{type:Date,default:null},createdAt:{type:Date,default:Date.now,immutable:true},
 emailState:{type:String,enum:['not_requested','pending','processing','retry','accepted','dead','suppressed'],default:'not_requested'},
 attempts:{type:Number,default:0,min:0,max:8},availableAt:{type:Date,default:Date.now},
 leaseUntil:{type:Date,default:null},leaseToken:{type:String,default:null},
 acceptedMessageId:{type:String,default:null,maxlength:160},acceptedAt:{type:Date,default:null},
 failureCode:{type:String,default:null,maxlength:60}
},{strict:'throw',versionKey:false});
schema.index({dedupeKey:1},{unique:true});
schema.index({recipientId:1,createdAt:-1,_id:-1});
schema.index({branchId:1,createdAt:-1});
schema.index({emailState:1,availableAt:1});
schema.index({emailState:1,leaseUntil:1});
module.exports=schema;
