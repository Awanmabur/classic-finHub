'use strict';
const mongoose=require('mongoose');
const schema=new mongoose.Schema({
 tenantId:{type:mongoose.Schema.Types.ObjectId,required:true,immutable:true},
 tenantSlug:{type:String,required:true,immutable:true,maxlength:130},
 authorName:{type:String,required:true,minlength:2,maxlength:80},
 rating:{type:Number,required:true,min:1,max:5},
 comment:{type:String,required:true,minlength:15,maxlength:1600},
 status:{type:String,required:true,enum:['pending','approved','rejected','withdrawn'],default:'pending'},
 tokenHash:{type:String,required:true,select:false,immutable:true},
 networkHash:{type:String,required:true,select:false,immutable:true},
 revision:{type:Number,default:0,min:0},
 ownerReply:{type:String,maxlength:1200,default:''},
 ownerReplyAt:Date,
 moderationReason:{type:String,maxlength:400,default:''},
 moderatedBy:{type:mongoose.Schema.Types.ObjectId},
 moderatedAt:Date,
 approvedAt:Date
},{timestamps:true,strict:'throw'});
schema.index({tenantId:1,status:1,approvedAt:-1,_id:-1});
schema.index({tenantId:1,createdAt:-1,_id:-1});
schema.index({networkHash:1,createdAt:-1});
schema.index({tenantSlug:1,tokenHash:1},{unique:true});
module.exports=mongoose.models.BusinessReview||mongoose.model('BusinessReview',schema);
