'use strict';
const mongoose=require('mongoose');
const O=mongoose.Schema.Types.ObjectId;
const schema=new mongoose.Schema({
  branchId:{type:O,required:true,immutable:true},
  kind:{type:String,enum:['sender','beneficiary'],required:true,immutable:true},
  fullName:{type:String,required:true,trim:true,maxlength:120},
  phone:{type:String,required:true,trim:true,maxlength:20},
  country:{type:String,required:true,uppercase:true,minlength:2,maxlength:2},
  active:{type:Boolean,default:true},
  createdBy:{type:O,required:true,immutable:true},
  updatedBy:{type:O,required:true},
  revision:{type:Number,default:0,min:0}
},{strict:'throw',timestamps:true,versionKey:false});
schema.index({branchId:1,kind:1,active:1,fullName:1,_id:1});
schema.index({branchId:1,createdAt:-1,_id:-1});
module.exports=schema;
