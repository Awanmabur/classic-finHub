'use strict';
// Internal indicative FX rate. Approval does not verify an external market rate.
const mongoose=require('mongoose');
const O=mongoose.Schema.Types.ObjectId;
const schema=new mongoose.Schema({
 branchId:{type:O,required:true,immutable:true},
 fromCurrency:{type:String,enum:['UGX','KES','USD','EUR'],required:true,immutable:true},
 toCurrency:{type:String,enum:['UGX','KES','USD','EUR'],required:true,immutable:true},
 // One source major unit equals the given number of target major units.
 rateDecimal:{type:String,required:true,immutable:true,match:/^(?:[1-9]\d{0,9}|0)\.\d{1,8}$|^[1-9]\d{0,9}$/},
 proposedBy:{type:O,required:true,immutable:true},
 status:{type:String,enum:['pending_review','active','rejected','superseded','expired'],default:'pending_review'},
 expiresAt:{type:Date,required:true,immutable:true},
 note:{type:String,required:true,maxlength:400,immutable:true},
 reviewedBy:{type:O},reviewedAt:{type:Date},reviewNote:{type:String,maxlength:400},
 revision:{type:Number,default:0,min:0}
},{strict:'throw',timestamps:true,versionKey:false});
schema.index({branchId:1,fromCurrency:1,toCurrency:1,status:1,createdAt:-1});
schema.index({branchId:1,fromCurrency:1,toCurrency:1},{unique:true,partialFilterExpression:{status:'active'},name:'one_active_forex_rate_per_pair'});
schema.index({status:1,expiresAt:1});
module.exports=schema;
