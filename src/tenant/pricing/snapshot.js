'use strict';
const {Schema}=require('mongoose');
const numeric={type:String,match:/^(?:0|[1-9]\d{0,17})$/,required:true,immutable:true};
const schema=new Schema({
 policyId:{type:String,default:null,immutable:true},revision:{type:Number,min:0,required:true,immutable:true},
 operation:{type:String,required:true,immutable:true},currency:{type:String,required:true,immutable:true},
 feeMinor:numeric,costMinor:numeric,fixedFeeMinor:numeric,feeBps:{type:Number,min:0,max:10000,required:true,immutable:true},
 fixedCostMinor:numeric,costBps:{type:Number,min:0,max:10000,required:true,immutable:true}
},{_id:false,strict:'throw'});
module.exports={schema};
