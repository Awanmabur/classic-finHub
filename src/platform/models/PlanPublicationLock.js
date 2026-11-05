'use strict';
const mongoose=require('mongoose');
const schema=new mongoose.Schema({
  _id:{type:String,enum:['catalogue'],required:true},
  revision:{type:Number,required:true,min:1}
},{versionKey:false,strict:'throw'});
module.exports=mongoose.models.PlanPublicationLock||mongoose.model('PlanPublicationLock',schema);
