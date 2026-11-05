'use strict';
const mongoose=require('mongoose');
const schema=new mongoose.Schema({
 tenantId:{type:mongoose.Schema.Types.ObjectId,required:true,index:true},
 moduleKey:{type:String,required:true,match:/^[a-z][a-z0-9_]{1,40}$/},
 requestedBy:{type:String,required:true},
 reason:{type:String,required:true,minlength:20,maxlength:600},
 status:{type:String,required:true,enum:['pending','approved','rejected'],default:'pending'},
 pricingSnapshot:{currency:{type:String,enum:['USD'],required:true},priceMonthlyMinor:{type:Number,required:true,min:0}},
 reviewedBy:{type:String},reviewedAt:{type:Date},platformAdminNote:{type:String,maxlength:600}
},{timestamps:true,strict:'throw'});
schema.index({tenantId:1,moduleKey:1},{unique:true,partialFilterExpression:{status:'pending'}});
schema.index({status:1,createdAt:-1});
module.exports=mongoose.models.ModuleRequest||mongoose.model('ModuleRequest',schema);
