'use strict';
const mongoose=require('mongoose');
const fields=new mongoose.Schema({
  operation:{type:String,enum:['cash_in','cash_out']},customer:{type:String,maxlength:120},
  network:{type:String,enum:require('../../config/mobileNetworks').smsNetworks},networkReference:{type:String,maxlength:100},
  observedWalletBalance:{type:String,maxlength:32},observationEvidenceReference:{type:String,maxlength:120},
  currency:{type:String,enum:require('../../config/currencies').currencyCodes},amount:{type:String,maxlength:20},fee:{type:String,maxlength:20}
},{_id:false,strict:'throw'});
const schema=new mongoose.Schema({
  deviceId:{type:String,required:true,immutable:true},messageId:{type:String,required:true,immutable:true,maxlength:128},
  payloadDigest:{type:String,required:true,immutable:true},
  operatorId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
  branchId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
  sender:{type:String,required:true,immutable:true,maxlength:40},receivedAt:{type:Date,required:true,immutable:true},
  bodyEncrypted:{type:String,required:true,select:false},
  fields:{type:fields,default:null},
  state:{type:String,enum:['needs_review','parsed','processing','recorded','dismissed'],required:true},
  processingToken:{type:String,default:null},processingUntil:{type:Date,default:null},
  reasonCode:{type:String,required:true,maxlength:80},
  recordId:{type:mongoose.Schema.Types.ObjectId,default:null},
  confirmedBy:{type:mongoose.Schema.Types.ObjectId,default:null},confirmedAt:{type:Date,default:null},
  dismissalNote:{type:String,maxlength:200,default:null},
  expiresAt:{type:Date,required:true,immutable:true}
},{timestamps:true,strict:'throw'});
schema.index({deviceId:1,messageId:1},{unique:true});
schema.index({branchId:1,operatorId:1,createdAt:-1,_id:-1});
schema.index({createdAt:-1,_id:-1});
schema.index({state:1,createdAt:-1,_id:-1});
schema.index({state:1,processingUntil:1});
schema.index({expiresAt:1},{expireAfterSeconds:0});
module.exports=schema;
