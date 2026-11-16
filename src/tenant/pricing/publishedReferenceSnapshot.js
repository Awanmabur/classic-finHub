'use strict';
const {Schema}=require('mongoose');
// A published provider table is NOT the tenant's approved rate schedule.
// Keep this immutable evidence separate from contracted/approved commission
// snapshots, customer fees, ledger lines, revenue and wallet balances.
const schema=new Schema({
 network:{type:String,required:true,immutable:true},
 operation:{type:String,required:true,immutable:true},
 currency:{type:String,required:true,immutable:true},
 amountMinor:{type:String,required:true,match:/^(?:0|[1-9][0-9]{0,17})$/,immutable:true},
 sourceUrl:{type:String,required:true,maxlength:300,immutable:true},
 checkedOn:{type:String,required:true,match:/^\d{4}-\d{2}-\d{2}$/,immutable:true},
 quotedAt:{type:Date,required:true,immutable:true},
 status:{type:String,enum:['reference_only','historical_unverified'],required:true,immutable:true}
},{_id:false,strict:'throw'});
module.exports={schema};
