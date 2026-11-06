'use strict';
// Requested banking operations cannot settle or modify balances. Later bank
// adapters must use the separate verified financial transaction engine.
const mongoose=require('mongoose');
const {currencyCodes}=require('../../config/currencies');
const O=mongoose.Schema.Types.ObjectId;
const account=new mongoose.Schema({
  referenceId:{type:O,required:true,immutable:true},
  referenceType:{type:String,enum:['bank_reference','customer_account'],default:'bank_reference',immutable:true},
  customerName:{type:String,required:true,immutable:true},
  institutionName:{type:String,required:true,immutable:true},
  last4:{type:String,required:true,immutable:true}
},{_id:false,strict:'throw'});
const schema=new mongoose.Schema({
 capture:{type:require('../services/operationCapture.service').schema('banking'),default:()=>({}),immutable:true},
  reference:{type:String,required:true,immutable:true},
  idempotencyKey:{type:String,required:true,immutable:true},
  branchId:{type:O,required:true,immutable:true},
  createdBy:{type:O,required:true,immutable:true},
  kind:{type:String,enum:['deposit_request','withdrawal_request','transfer_request'],required:true,immutable:true},
  source:{type:account,required:true,immutable:true},
  destination:{type:account,default:null,immutable:true},
  currency:{type:String,enum:currencyCodes,required:true,immutable:true},
  amountMinor:{type:mongoose.Schema.Types.Decimal128,required:true,immutable:true},
  note:{type:String,required:true,maxlength:400,immutable:true},
  validDays:{type:Number,required:true,min:1,max:30,immutable:true},
  expiresAt:{type:Date,required:true,immutable:true},
  status:{type:String,enum:['requested','approved_pending_bank','rejected','cancelled','expired'],required:true,default:'requested'},
  reviewedBy:{type:O},reviewedAt:{type:Date},reviewNote:{type:String,maxlength:400},
  cancelledBy:{type:O},cancelledAt:{type:Date},cancelReason:{type:String,maxlength:400},
  expiredAt:{type:Date},
  revision:{type:Number,default:0,min:0}
},{strict:'throw',timestamps:true,versionKey:false});
schema.index({reference:1},{unique:true});
schema.index({idempotencyKey:1},{unique:true});
schema.index({branchId:1,createdAt:-1,_id:-1});
schema.index({createdBy:1,createdAt:-1,_id:-1});
schema.index({branchId:1,status:1,createdAt:1});
schema.index({status:1,expiresAt:1});
module.exports=schema;
