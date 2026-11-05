'use strict';
const mongoose=require('mongoose');
const schema=new mongoose.Schema({
  deviceId:{type:String,required:true,immutable:true,match:/^[a-f0-9]{32}$/},
  tenantId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
  operatorId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
  branchId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
  name:{type:String,required:true,maxlength:80},
  network:{type:String,enum:['MTN','Airtel','M-Pesa'],required:true,immutable:true},
  allowedSenders:{type:[String],required:true},
  secretEncrypted:{type:String,required:true,select:false},
  autoRecord:{type:Boolean,default:false},
  status:{type:String,enum:['active','revoked'],default:'active'},
  revision:{type:Number,default:0,min:0},
  createdBy:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
  revokedAt:{type:Date,default:null},
  lastReceivedAt:{type:Date,default:null}
},{timestamps:true,strict:'throw'});
schema.index({deviceId:1},{unique:true});
schema.index({tenantId:1,status:1,createdAt:-1});
schema.index({tenantId:1,createdAt:-1});
module.exports=mongoose.models.SmsDevice||mongoose.model('SmsDevice',schema);
