'use strict';
const mongoose=require('mongoose');
const schema=new mongoose.Schema({
  tenantId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
  generation:{type:Number,required:true,min:1,immutable:true},
  period:{type:String,required:true,match:/^\d{4}-\d{2}$/,immutable:true},
  metric:{type:String,required:true,enum:['mobile_money_records','money_transfer_requests','banking_requests','forex_quotes','customers','customer_accounts','expenses','addon_mobile_money_records','addon_money_transfer_requests','addon_banking_requests','addon_forex_quotes','addon_customers','addon_customer_accounts','addon_expenses'],immutable:true},
  quantity:{type:Number,required:true,min:0,default:0}
},{timestamps:true,strict:'throw'});
schema.index({tenantId:1,generation:1,period:1,metric:1},{unique:true});
module.exports=mongoose.models.UsageCounter||mongoose.model('UsageCounter',schema);
