'use strict';
const mongoose=require('mongoose');
const schema=new mongoose.Schema({
 userId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
 emailOptIn:{type:Boolean,required:true,default:false},
 updatedAt:{type:Date,required:true,default:Date.now}
},{strict:'throw',versionKey:false});
schema.index({userId:1},{unique:true});
module.exports=schema;
