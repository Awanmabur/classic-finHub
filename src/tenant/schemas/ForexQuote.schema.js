'use strict';
// Immutable FX quotation, not a trade, receipt or custody instruction.
const mongoose=require('mongoose');
const {forexCurrencyCodes}=require('../../config/currencies');
const O=mongoose.Schema.Types.ObjectId;
const schema=new mongoose.Schema({
 capture:{type:require('../services/operationCapture.service').schema('forex'),default:()=>({}),immutable:true},
 reference:{type:String,required:true,immutable:true},
 idempotencyKey:{type:String,required:true,immutable:true},
 branchId:{type:O,required:true,immutable:true},createdBy:{type:O,required:true,immutable:true},
 customerLabel:{type:String,required:true,maxlength:120,immutable:true},
 operation:{type:String,enum:['buy','sell','quote'],default:'quote',immutable:true},
 rateId:{type:O,required:true,immutable:true},
 fromCurrency:{type:String,enum:forexCurrencyCodes,required:true,immutable:true},toCurrency:{type:String,enum:forexCurrencyCodes,required:true,immutable:true},
 rateDecimal:{type:String,required:true,immutable:true},
 sourceMinor:{type:mongoose.Schema.Types.Decimal128,required:true,immutable:true},
 targetMinor:{type:mongoose.Schema.Types.Decimal128,required:true,immutable:true},
 expiresAt:{type:Date,required:true,immutable:true},
 validMinutes:{type:Number,min:5,max:60,required:true,immutable:true},
 note:{type:String,required:true,maxlength:400,immutable:true},
 status:{type:String,enum:['quoted','approved_pending_execution','posted_manual','rejected','cancelled','expired'],default:'quoted'},
 manualExecutionId:{type:O,default:null},manualPostedAt:{type:Date,default:null},
 reviewedBy:{type:O},reviewedAt:{type:Date},reviewNote:{type:String,maxlength:400},
 cancelledBy:{type:O},cancelledAt:{type:Date},cancelNote:{type:String,maxlength:400},
 expiredAt:{type:Date},revision:{type:Number,default:0,min:0}
},{strict:'throw',timestamps:true,versionKey:false});
schema.index({reference:1},{unique:true});schema.index({idempotencyKey:1},{unique:true});
schema.index({branchId:1,createdAt:-1,_id:-1});schema.index({createdBy:1,createdAt:-1,_id:-1});
schema.index({branchId:1,status:1,createdAt:1});schema.index({status:1,expiresAt:1});
module.exports=schema;
