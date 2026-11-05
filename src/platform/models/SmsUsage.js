'use strict';
const mongoose=require('mongoose');
const schema=new mongoose.Schema({
  tenantId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
  generation:{type:Number,required:true,min:1,immutable:true},
  period:{type:String,required:true,match:/^\d{4}-\d{2}$/,immutable:true},
  quantity:{type:Number,required:true,min:0,default:0}
},{timestamps:true,strict:'throw'});
schema.index({tenantId:1,generation:1,period:1},{unique:true});
module.exports=mongoose.models.SmsUsage||mongoose.model('SmsUsage',schema);
