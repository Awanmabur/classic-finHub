'use strict';
const mongoose=require('mongoose');const O=mongoose.Schema.Types.ObjectId;
const steps=['Tenant Owner','Branch Manager','Approval Officer','Reconciliation Officer'];
const decision=new mongoose.Schema({
 stepIndex:{type:Number,required:true,min:0,max:2}, actorId:{type:O,required:true},
 role:{type:String,required:true,enum:steps},decision:{type:String,required:true,enum:['approve','reject']},
 note:{type:String,required:true,minlength:12,maxlength:400},at:{type:Date,required:true}
},{_id:false,strict:'throw'});
const schema=new mongoose.Schema({
 reference:{type:String,required:true,immutable:true},
 idempotencyKey:{type:String,required:true,immutable:true},
 policyCode:{type:String,required:true,immutable:true},policyVersion:{type:Number,required:true,immutable:true},
 policyName:{type:String,required:true,immutable:true},category:{type:String,required:true,immutable:true},
 steps:{type:[{type:String,enum:steps}],required:true,immutable:true,validate:{validator:v=>v.length>=1&&v.length<=3}},
 subject:{type:String,required:true,immutable:true,minlength:4,maxlength:120},
 justification:{type:String,required:true,immutable:true,minlength:15,maxlength:1000},
 branchId:{type:O,required:true,immutable:true},requesterId:{type:O,required:true,immutable:true},
 status:{type:String,enum:['pending','approved','rejected','cancelled','expired'],default:'pending'},
 currentStep:{type:Number,default:0,min:0,max:3}, decisions:{type:[decision],default:[]},
 expiresAt:{type:Date,required:true,immutable:true},
 terminalBy:{type:O,default:null},terminalAt:{type:Date,default:null},terminalNote:{type:String,default:null,maxlength:400},
 revision:{type:Number,default:0,min:0}
},{strict:'throw',timestamps:true,versionKey:false});
schema.index({idempotencyKey:1},{unique:true});schema.index({reference:1},{unique:true});
schema.index({branchId:1,createdAt:-1,_id:-1});schema.index({requesterId:1,createdAt:-1,_id:-1});
schema.index({branchId:1,status:1,expiresAt:1});schema.index({status:1,expiresAt:1});
module.exports=schema;
