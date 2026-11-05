'use strict';
const mongoose=require('mongoose');
const limitsSchema=new mongoose.Schema({
  users:{type:Number,required:true,min:1},branches:{type:Number,required:true,min:1},
  transactionsPerMonth:{type:Number,required:true,min:0},smsPerMonth:{type:Number,required:true,min:0},storageMb:{type:Number,required:true,min:0}
},{_id:false,strict:'throw'});
const schema=new mongoose.Schema({
  code:{type:String,required:true,match:/^[a-z][a-z0-9_]{1,40}$/,immutable:true},
  version:{type:Number,required:true,min:1,immutable:true},
  name:{type:String,required:true,immutable:true,maxlength:100},
  description:{type:String,required:true,immutable:true,maxlength:1000},
  currency:{type:String,required:true,enum:['USD'],immutable:true},
  priceMonthlyMinor:{type:Number,required:true,min:0,immutable:true},
  priceYearlyMinor:{type:Number,required:true,min:0,immutable:true},
  trialMonths:{type:Number,required:true,min:0,max:3,immutable:true},
  modules:{type:[String],required:true,immutable:true},
  entryMode:{type:String,enum:['manual','sms_assisted'],immutable:true},
  manualPlanCode:{type:String,match:/^[a-z][a-z0-9_]{1,40}$/,immutable:true},
  manualPlanVersion:{type:Number,min:1,immutable:true},
  availableForNewTenants:{type:Boolean,immutable:true},
  limits:{type:limitsSchema,required:true,immutable:true},
  sourceHash:{type:String,required:true,match:/^[a-f0-9]{64}$/,immutable:true},
  status:{type:String,enum:['published'],default:'published',immutable:true},
  publishedAt:{type:Date,required:true,immutable:true}
},{timestamps:true,strict:'throw'});
schema.index({code:1,version:1},{unique:true});
module.exports=mongoose.models.PlanVersion||mongoose.model('PlanVersion',schema);
