'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  eventKey: { type:String,required:true,immutable:true,maxlength:160 },
  type: {type:String,required:true,immutable:true,enum:['subscription.granted','subscription.revoked']},
  tenantId: {type:mongoose.Schema.Types.ObjectId,required:true,immutable:true,ref:'Tenant'},
  // Contains notification addressing only, never credentials, invitation secrets or payment details.
  payload: {type:new mongoose.Schema({to:{type:String,required:true,maxlength:254},tenantName:{type:String,required:true,maxlength:150},
    planName:{type:String,maxlength:120},expiresAt:{type:Date}},{_id:false,strict:'throw'}),required:true,immutable:true},
  state: {type:String,enum:['pending','processing','accepted','dead'],default:'pending',required:true},
  availableAt: {type:Date,default:Date.now,required:true},
  leaseToken:{type:String,default:null},
  leaseUntil:{type:Date,default:null},
  workerId:{type:String,default:null},
  attempts:{type:Number,default:0,min:0},
  maxAttempts:{type:Number,default:8,min:1,max:12},
  failureCode:{type:String,default:null,maxlength:48},
  providerAcceptance:{type:new mongoose.Schema({provider:{type:String},messageId:{type:String},acceptedAt:{type:Date}}, {_id:false,strict:'throw'}),default:undefined},
  completedAt:{type:Date,default:null},
  purgeAt:{type:Date,default:null}
}, {timestamps:true,strict:'throw'});
schema.index({eventKey:1},{unique:true});
schema.index({state:1,availableAt:1,createdAt:1});
schema.index({state:1,leaseUntil:1});
schema.index({tenantId:1,createdAt:-1});
schema.index({purgeAt:1},{expireAfterSeconds:0}); // Accepted delivery metadata only, after 90d
module.exports=mongoose.models.OutboxEvent||mongoose.model('OutboxEvent',schema);
