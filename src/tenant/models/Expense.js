'use strict';
const {Schema}=require('mongoose');
const snapshot=new Schema({expenseType:{type:String,required:true,maxlength:100},amountMinor:{type:Schema.Types.Decimal128,required:true},
 vendor:{type:String,default:'',maxlength:120},reference:{type:String,default:'',maxlength:120},description:{type:String,default:'',maxlength:400}},
 {_id:false,strict:'throw'});
const change=new Schema({kind:{type:String,enum:['correct','void'],required:true},requestedBy:{type:Schema.Types.ObjectId,required:true},
 requestedAt:{type:Date,required:true},reason:{type:String,required:true,maxlength:400},values:{type:snapshot,default:null}},
 {_id:false,strict:'throw'});
const history=new Schema({action:{type:String,required:true},actorId:{type:Schema.Types.ObjectId,required:true},at:{type:Date,required:true},
 note:{type:String,default:'',maxlength:400},before:{type:snapshot,default:null},after:{type:snapshot,default:null},
 treasuryBatchId:{type:Schema.Types.ObjectId,default:null},reversalBatchId:{type:Schema.Types.ObjectId,default:null}},
 {_id:false,strict:'throw'});
const schema=new Schema({
 recordReference:{type:String,required:true,immutable:true},idempotencyKey:{type:String,required:true,immutable:true},
 branchId:{type:Schema.Types.ObjectId,required:true,immutable:true},operatorId:{type:Schema.Types.ObjectId,required:true,immutable:true},
 currency:{type:String,enum:require('../../config/currencies').currencyCodes,required:true,immutable:true},paymentMethod:{type:String,enum:['Cash','Mobile Money','Bank'],required:true,immutable:true},
 cashSessionId:{type:Schema.Types.ObjectId,default:null,immutable:true},
 // The requested source is immutable. The independently selected posting source
 // and append-only batch are assigned only while accepting a pending expense.
 treasuryAccountId:{type:Schema.Types.ObjectId,default:null,immutable:true},
 sourcePolicy:{type:String,enum:['legacy_untracked','funded_required'],default:'legacy_untracked',immutable:true},
 postedTreasuryAccountId:{type:Schema.Types.ObjectId,default:null},
 treasuryBatchId:{type:Schema.Types.ObjectId,default:null},lastReversalBatchId:{type:Schema.Types.ObjectId,default:null},postingSequence:{type:Number,default:0,min:0},
 expenseType:{type:String,required:true,maxlength:100},amountMinor:{type:Schema.Types.Decimal128,required:true},
 vendor:{type:String,default:'',maxlength:120},reference:{type:String,default:'',maxlength:120},description:{type:String,default:'',maxlength:400},
 original:{type:snapshot,required:true,immutable:true},
 status:{type:String,enum:['pending_review','approved','rejected','voided'],default:'pending_review',required:true},
 reviewedBy:{type:Schema.Types.ObjectId,default:null},reviewedAt:{type:Date,default:null},reviewNote:{type:String,default:'',maxlength:400},
 correctionState:{type:String,enum:['none','requested','applied','denied'],default:'none'},pendingChange:{type:change,default:null},
 history:{type:[history],default:[]},revision:{type:Number,default:0,min:0}
},{timestamps:true,strict:'throw'});
schema.index({recordReference:1},{unique:true});schema.index({idempotencyKey:1},{unique:true});
schema.index({createdAt:-1,_id:-1});schema.index({branchId:1,operatorId:1,createdAt:-1,_id:-1});
schema.index({branchId:1,createdAt:-1,_id:-1});schema.index({operatorId:1,createdAt:-1,_id:-1});
schema.index({cashSessionId:1,status:1,correctionState:1});
module.exports=schema;
