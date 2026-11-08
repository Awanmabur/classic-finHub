'use strict';
const {Schema}=require('mongoose');
const {currencyCodes}=require('../../config/currencies');
const O=Schema.Types.ObjectId,D=Schema.Types.Decimal128;
const accountSchema=new Schema({
 tenantId:{type:O,required:true,immutable:true},branchId:{type:O,required:true,immutable:true},
 code:{type:String,required:true,immutable:true,match:/^[A-Z][A-Z0-9_]{2,39}$/},name:{type:String,required:true,maxlength:120},
 kind:{type:String,enum:['wallet','cash','bank','forex_stock','transfer_clearing'],required:true,immutable:true},
 moduleKey:{type:String,enum:['shared','mobile_money','forex','money_transfer'],required:true,immutable:true},
 network:{type:String,enum:['',...require('../../config/mobileNetworks').networks],default:'',immutable:true},
 currency:{type:String,enum:currencyCodes,required:true,immutable:true},operatorId:{type:O,default:null,immutable:true},
 accountReference:{type:String,maxlength:80,default:'',immutable:true},selectionKey:{type:String,default:undefined},
 feeTreatment:{type:String,enum:['record_only','payment_collected','wallet_commission'],default:'record_only'},
 ledgerAccountId:{type:O,required:true,immutable:true},ledgerCode:{type:String,required:true,immutable:true},
 status:{type:String,enum:['uninitialized','active','held','archived'],default:'uninitialized'},
 openingBalanceMinor:{type:D,default:null},openingObservedAt:{type:Date,default:null},openingObservationId:{type:O,default:null},openingApprovedAt:{type:Date,default:null},
 bookBalanceMinor:{type:D,required:true,default:'0'},sequence:{type:Number,default:0,min:0},revision:{type:Number,default:0,min:0},
 lastObservationId:{type:O,default:null},lastObservationAt:{type:Date,default:null},lastObservedMinor:{type:D,default:null},
 lastExpectedAtObservationMinor:{type:D,default:null},lastVarianceMinor:{type:D,default:null},
 reconciliationState:{type:String,enum:['unknown','matched','mismatch','stale'],default:'unknown'},
 holdReason:{type:String,default:'',maxlength:120},lastObservationStale:{type:Boolean,default:false},
 pendingOpeningId:{type:O,default:null},createdBy:{type:O,required:true,immutable:true}
},{timestamps:true,strict:'throw'});
accountSchema.index({branchId:1,code:1},{unique:true});accountSchema.index({ledgerAccountId:1},{unique:true});
accountSchema.index({selectionKey:1},{unique:true,partialFilterExpression:{selectionKey:{$type:'string'}}});
accountSchema.index({branchId:1,kind:1,network:1,currency:1,operatorId:1,status:1});
const observationSchema=new Schema({
 tenantId:{type:O,required:true,immutable:true},branchId:{type:O,required:true,immutable:true},accountId:{type:O,required:true,immutable:true},
 idempotencyKey:{type:String,required:true,immutable:true},kind:{type:String,enum:['opening','checkpoint'],required:true,immutable:true},
 observedAt:{type:Date,required:true,immutable:true},actualMinor:{type:D,required:true,immutable:true},expectedMinorAtRequest:{type:D,default:null,immutable:true},
 varianceMinorAtRequest:{type:D,default:null,immutable:true},evidenceType:{type:String,enum:['cash_count','provider_statement','provider_app','provider_sms','bank_statement','stock_count','transfer_register'],required:true,immutable:true},
 evidenceReference:{type:String,required:true,maxlength:120,immutable:true},evidenceDigest:{type:String,match:/^[a-f0-9]{64}$/,default:undefined,immutable:true},
 note:{type:String,required:true,maxlength:400,immutable:true},requestedBy:{type:O,required:true,immutable:true},
 status:{type:String,enum:['pending_review','approved','rejected'],default:'pending_review'},reviewedBy:{type:O,default:null},reviewedAt:{type:Date,default:null},reviewNote:{type:String,maxlength:400,default:''},
 expectedMinorAtReview:{type:D,default:null},varianceMinorAtReview:{type:D,default:null},openingJournalId:{type:O,default:null},
 createdAt:{type:Date,default:Date.now,immutable:true}
},{strict:'throw',versionKey:false});
observationSchema.index({idempotencyKey:1},{unique:true});observationSchema.index({accountId:1,createdAt:-1,_id:-1});
observationSchema.index({branchId:1,status:1,createdAt:1});
function appendOnly(schema){schema.set('versionKey',false);schema.pre('save',function(next){next(this.isNew?null:new Error('Treasury evidence and movements are append-only'));});for(const op of ['updateOne','updateMany','replaceOne','findOneAndUpdate','findOneAndReplace','deleteOne','deleteMany','findOneAndDelete'])schema.pre(op,function(next){next(new Error('Treasury evidence and movements are append-only'));});}
const batchSchema=new Schema({
 tenantId:{type:O,required:true,immutable:true},branchId:{type:O,required:true,immutable:true},actorId:{type:O,required:true,immutable:true},operatingActorId:{type:O,required:true,immutable:true},
 sourceType:{type:String,enum:['mobile_money','money_transfer','banking','forex','expenses','treasury_adjustment','treasury_funding'],required:true,immutable:true},
 sourceRef:{type:String,required:true,maxlength:120,immutable:true},fingerprint:{type:String,required:true,match:/^[a-f0-9]{64}$/,immutable:true},
 description:{type:String,required:true,maxlength:400,immutable:true},evidenceReference:{type:String,maxlength:120,default:'',immutable:true},
 occurredAt:{type:Date,required:true,immutable:true},journalIds:{type:[O],required:true,immutable:true},
 reversesBatchId:{type:O,default:null,immutable:true},createdAt:{type:Date,default:Date.now,immutable:true}
},{strict:'throw'});appendOnly(batchSchema);
batchSchema.index({sourceType:1,sourceRef:1},{unique:true});batchSchema.index({reversesBatchId:1},{unique:true,partialFilterExpression:{reversesBatchId:{$type:'objectId'}}});
batchSchema.index({branchId:1,createdAt:-1,_id:-1});
const movementSchema=new Schema({
 tenantId:{type:O,required:true,immutable:true},branchId:{type:O,required:true,immutable:true},accountId:{type:O,required:true,immutable:true},batchId:{type:O,required:true,immutable:true},
 sourceType:{type:String,required:true,immutable:true},sourceRef:{type:String,required:true,maxlength:120,immutable:true},
 sequence:{type:Number,required:true,min:1,immutable:true},currency:{type:String,enum:currencyCodes,required:true,immutable:true},
 deltaMinor:{type:D,required:true,immutable:true},balanceAfterMinor:{type:D,required:true,immutable:true},
 occurredAt:{type:Date,required:true,immutable:true},actorId:{type:O,required:true,immutable:true},journalId:{type:O,required:true,immutable:true},createdAt:{type:Date,default:Date.now,immutable:true}
},{strict:'throw'});appendOnly(movementSchema);
movementSchema.index({accountId:1,sequence:1},{unique:true});movementSchema.index({batchId:1,accountId:1},{unique:true});
movementSchema.index({accountId:1,occurredAt:1,createdAt:1});movementSchema.index({branchId:1,createdAt:-1,_id:-1});
movementSchema.index({tenantId:1,sourceType:1,occurredAt:1,branchId:1});
const counterSchema=new Schema({tenantId:{type:O,required:true,immutable:true},branchId:{type:O,required:true,immutable:true},currency:{type:String,enum:currencyCodes,required:true,immutable:true},purpose:{type:String,enum:['opening_equity','settlement_clearing','reconciliation_suspense','fee_income','expense','interbranch_payable','interbranch_receivable'],required:true,immutable:true},ledgerAccountId:{type:O,required:true,immutable:true},ledgerCode:{type:String,required:true,immutable:true}},{strict:'throw'});appendOnly(counterSchema);counterSchema.index({branchId:1,currency:1,purpose:1},{unique:true});
const adjustmentSchema=new Schema({
 tenantId:{type:O,required:true,immutable:true},branchId:{type:O,required:true,immutable:true},accountId:{type:O,required:true,immutable:true},observationId:{type:O,required:true,immutable:true},
 idempotencyKey:{type:String,required:true,immutable:true},deltaMinor:{type:D,required:true,immutable:true},reason:{type:String,required:true,maxlength:400,immutable:true},requestedBy:{type:O,required:true,immutable:true},
 status:{type:String,enum:['pending_review','approved','rejected'],default:'pending_review'},reviewedBy:{type:O,default:null},reviewedAt:{type:Date,default:null},reviewNote:{type:String,maxlength:400,default:''},batchId:{type:O,default:null},createdAt:{type:Date,default:Date.now,immutable:true}
},{strict:'throw',versionKey:false});adjustmentSchema.index({idempotencyKey:1},{unique:true});adjustmentSchema.index({observationId:1},{unique:true});adjustmentSchema.index({branchId:1,status:1,createdAt:1});
const model=(conn,name,schema)=>conn.models[name]||conn.model(name,schema);
function models(conn){return {account:model(conn,'TreasuryAccountV1',accountSchema),observation:model(conn,'TreasuryObservationV1',observationSchema),batch:model(conn,'TreasuryBatchV1',batchSchema),movement:model(conn,'TreasuryMovementV1',movementSchema),counter:model(conn,'TreasuryCounterV1',counterSchema),adjustment:model(conn,'TreasuryAdjustmentV1',adjustmentSchema)};}
const pending=new WeakMap();function ensure(conn){if(!pending.has(conn))pending.set(conn,Promise.all(Object.values(models(conn)).map(m=>m.createIndexes())).catch(error=>{pending.delete(conn);throw error;}));return pending.get(conn);}
module.exports={models,ensure,accountSchema,observationSchema,batchSchema,movementSchema,counterSchema,adjustmentSchema};
