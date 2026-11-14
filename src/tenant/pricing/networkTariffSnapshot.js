'use strict';
const {Schema}=require('mongoose');
const schema=new Schema({
 scheduleId:{type:Schema.Types.ObjectId,required:true,immutable:true},
 version:{type:Number,min:1,required:true,immutable:true},
 scheduleKind:{type:String,enum:['agent_commission','customer_network_fee'],required:true,immutable:true},
 network:{type:String,required:true,immutable:true},
 operation:{type:String,required:true,immutable:true},
 currency:{type:String,required:true,immutable:true},
 amountMinor:{type:String,required:true,match:/^(?:0|[1-9][0-9]{0,17})$/,immutable:true},
 quotedAt:{type:Date,required:true,immutable:true},
 status:{type:String,enum:['estimated_not_received'],default:'estimated_not_received',immutable:true}
},{_id:false,strict:'throw'});
module.exports={schema};
