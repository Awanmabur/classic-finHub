'use strict';
// This is a limited, non-sensitive bank account *reference*, not a bank account
// held by ClassicFin. No full account number, credentials, or balances stored.
const mongoose=require('mongoose');
const {currencyCodes}=require('../../config/currencies');
const O=mongoose.Schema.Types.ObjectId;
const schema=new mongoose.Schema({
  branchId:{type:O,required:true,immutable:true},
  customerName:{type:String,trim:true,required:true,maxlength:120},
  institutionName:{type:String,trim:true,required:true,maxlength:120},
  last4:{type:String,required:true,match:/^[A-Za-z0-9]{4}$/},
  currency:{type:String,enum:currencyCodes,required:true,immutable:true},
  status:{type:String,enum:['active','archived'],default:'active'},
  createdBy:{type:O,required:true,immutable:true},
  updatedBy:{type:O,required:true},
  revision:{type:Number,default:0,min:0}
},{strict:'throw',timestamps:true,versionKey:false});
schema.index({branchId:1,status:1,customerName:1,_id:1});
module.exports=schema;
