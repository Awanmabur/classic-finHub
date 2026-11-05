'use strict';
const mongoose=require('mongoose');
const O=mongoose.Schema.Types.ObjectId;
const STEPS=['Tenant Owner','Branch Manager','Approval Officer','Reconciliation Officer'];
const step=new mongoose.Schema({role:{type:String,required:true,enum:STEPS}},{_id:false,strict:'throw'});
const schema=new mongoose.Schema({
 code:{type:String,required:true,immutable:true,match:/^[a-z][a-z0-9_]{2,39}$/},
 version:{type:Number,required:true,immutable:true,min:1,max:99999},
 name:{type:String,required:true,immutable:true,minlength:3,maxlength:100},
 category:{type:String,required:true,immutable:true,enum:['general','procurement','operational_exception','policy_change']},
 steps:{type:[step],required:true,immutable:true,validate:{validator:v=>v.length>=1&&v.length<=3}},
 expiresHours:{type:Number,required:true,immutable:true,min:1,max:720},
 status:{type:String,enum:['active','retired'],default:'active'},
 createdBy:{type:O,required:true,immutable:true}, retiredBy:{type:O,default:null},retiredAt:{type:Date,default:null}
},{strict:'throw',timestamps:true,versionKey:false});
schema.index({code:1,version:1},{unique:true});
schema.index({code:1},{unique:true,partialFilterExpression:{status:'active'}});
module.exports=schema;
