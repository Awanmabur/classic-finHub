'use strict';
const mongoose=require('mongoose');
const {currencyCodes}=require('../../config/currencies');
const O=mongoose.Schema.Types.ObjectId;
const party=new mongoose.Schema({contactId:{type:O,default:null,immutable:true},name:{type:String,required:true,maxlength:120,immutable:true},phone:{type:String,required:true,maxlength:16,immutable:true},country:{type:String,required:true,minlength:2,maxlength:2,immutable:true}}, {_id:false,strict:'throw'});
const schema=new mongoose.Schema({
 partyEntryMode:{type:String,enum:['typed','saved_contact'],default:'saved_contact',required:true,immutable:true},
 capture:{type:require('../services/operationCapture.service').schema('money_transfer'),default:()=>({}),immutable:true},
  reference:{type:String,required:true,immutable:true},idempotencyKey:{type:String,required:true,immutable:true},
  branchId:{type:O,required:true,immutable:true},createdBy:{type:O,required:true,immutable:true},
  sender:{type:party,required:true,immutable:true},beneficiary:{type:party,required:true,immutable:true},
  currency:{type:String,enum:currencyCodes,required:true,immutable:true},
  amountMinor:{type:mongoose.Schema.Types.Decimal128,required:true,immutable:true},feeMinor:{type:mongoose.Schema.Types.Decimal128,required:true,immutable:true},
  status:{type:String,enum:['requested','approved_pending_provider','collected_manual','paid_out_manual','rejected','cancelled','expired'],default:'requested',required:true},
  validDays:{type:Number,min:1,max:30,required:true,immutable:true},expiresAt:{type:Date,required:true,immutable:true},
  manualCollectionExecutionId:{type:O,default:null},manualPayoutExecutionId:{type:O,default:null},manualPostedAt:{type:Date,default:null},
  reviewedBy:{type:O},reviewedAt:{type:Date},reviewNote:{type:String,maxlength:400},
  cancelledAt:{type:Date},cancelledBy:{type:O},cancelReason:{type:String,maxlength:400},
  expiredAt:{type:Date},revision:{type:Number,default:0,min:0}
},{strict:'throw',timestamps:true,versionKey:false});
schema.index({reference:1},{unique:true});
schema.index({idempotencyKey:1},{unique:true});
schema.index({branchId:1,createdAt:-1,_id:-1});
schema.index({branchId:1,status:1,createdAt:-1});
schema.index({createdBy:1,createdAt:-1,_id:-1});
schema.index({status:1,expiresAt:1});
module.exports=schema;
