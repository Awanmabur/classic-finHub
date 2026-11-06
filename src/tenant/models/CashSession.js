'use strict';
const mongoose=require('mongoose');
const {currencyCodes}=require('../../config/currencies');
const {Schema}=mongoose;
const closeHistory=new Schema({at:{type:Date,required:true},actorId:{type:Schema.Types.ObjectId,required:true},declaredMinor:{type:Schema.Types.Decimal128,required:true},expectedMinor:{type:Schema.Types.Decimal128,required:true},varianceMinor:{type:Schema.Types.Decimal128,required:true},note:{type:String,required:true,maxlength:400}},{_id:false,strict:'throw'});
const schema=new Schema({
 branchId:{type:Schema.Types.ObjectId,required:true,immutable:true},operatorId:{type:Schema.Types.ObjectId,required:true,immutable:true},
 currency:{type:String,enum:currencyCodes,required:true,immutable:true},activeKey:{type:String,default:undefined},
 status:{type:String,enum:['pending_open','opening_rejected','open','submitted','disputed','approved'],default:'pending_open',required:true},
 treasuryAccountId:{type:Schema.Types.ObjectId,default:null},treasuryBoundAt:{type:Date,default:null},treasuryBaselineMinor:{type:Schema.Types.Decimal128,default:null},treasuryObservationId:{type:Schema.Types.ObjectId,default:null},treasuryOpeningObservationId:{type:Schema.Types.ObjectId,default:null},
 openingMinor:{type:Schema.Types.Decimal128,required:true,immutable:true},
 openingVerifiedBy:{type:Schema.Types.ObjectId,default:null},openingVerifiedAt:{type:Date,default:null},openingReviewNote:{type:String,default:null,maxlength:400},
 provisionalMovementMinor:{type:Schema.Types.Decimal128,required:true,default:'0'},recordCount:{type:Number,default:0,min:0},
 declaredClosingMinor:{type:Schema.Types.Decimal128,default:null},expectedClosingMinor:{type:Schema.Types.Decimal128,default:null},
 varianceMinor:{type:Schema.Types.Decimal128,default:null},submittedAt:{type:Date,default:null},
 reviewedBy:{type:Schema.Types.ObjectId,default:null},reviewedAt:{type:Date,default:null},reviewNote:{type:String,default:null,maxlength:400},
 closeHistory:{type:[closeHistory],default:[]},revision:{type:Number,default:0,min:0}
},{timestamps:true,strict:'throw'});
schema.index({activeKey:1},{unique:true,partialFilterExpression:{activeKey:{$type:'string'}}});
schema.index({branchId:1,createdAt:-1});schema.index({operatorId:1,createdAt:-1});schema.index({status:1,createdAt:1});
module.exports=schema;
