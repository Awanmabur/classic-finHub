'use strict';
const mongoose=require('mongoose');
const schema=new mongoose.Schema({
  code:{type:String,required:true,match:/^[a-z][a-z0-9_]{1,40}$/,immutable:true},
  terms:{type:mongoose.Schema.Types.Mixed,required:true},
  baseVersion:{type:Number,required:true,min:0},
  revision:{type:Number,required:true,min:1},
  publishedDraftRevision:{type:Number,default:0,min:0},
  createdBy:{type:String,required:true,immutable:true},
  updatedBy:{type:String,required:true}
},{timestamps:true,strict:'throw'});
schema.index({code:1},{unique:true});
module.exports=mongoose.models.PlanDraft||mongoose.model('PlanDraft',schema);
