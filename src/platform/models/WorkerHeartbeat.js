'use strict';
const mongoose=require('mongoose');
const schema=new mongoose.Schema({
  workerId:{type:String,required:true,immutable:true},
  seenAt:{type:Date,required:true},
  expiresAt:{type:Date,required:true}
},{strict:'throw',timestamps:true});
schema.index({workerId:1},{unique:true});
schema.index({expiresAt:1},{expireAfterSeconds:0});
module.exports=mongoose.models.WorkerHeartbeat||mongoose.model('WorkerHeartbeat',schema);
