'use strict';
// Opt-in future settlement collections. No automatic index creation on web reads.
// A quote is never a completed payment. All events must be audit-tracked and
// balance-affecting transitions executed with the source transaction in MongoDB.
const {Schema}=require('mongoose');
const {currencyCodes}=require('../../config/currencies');
const O=Schema.Types.ObjectId,D=Schema.Types.Decimal128;
const rate=new Schema({
 rateId:{type:O,required:true,immutable:true},side:{type:String,enum:['buy','sell'],required:true,immutable:true},
 fromCurrency:{type:String,enum:currencyCodes,required:true,immutable:true},
 toCurrency:{type:String,enum:currencyCodes,required:true,immutable:true},
 rateDecimal:{type:String,required:true,immutable:true},
 approvedBy:{type:O,required:true,immutable:true},
 expiresAt:{type:Date,required:true,immutable:true}
},{_id:false,strict:'throw'});
const settlement=new Schema({
 tenantId:{type:O,required:true,immutable:true},branchId:{type:O,required:true,immutable:true},
 sourceModule:{type:String,enum:['mobile_money','money_transfer'],required:true,immutable:true},
 sourceId:{type:O,required:true,immutable:true},sourceReference:{type:String,required:true,maxlength:120,immutable:true},
 idempotencyKey:{type:String,required:true,immutable:true,match:/^[a-f0-9-]{36}$/i},
 sourceFingerprint:{type:String,required:true,immutable:true,match:/^[a-f0-9]{64}$/},
 operation:{type:String,enum:['cash_in','cash_out','transfer_cross_currency'],required:true,immutable:true},
 providerCurrency:{type:String,enum:currencyCodes,required:true,immutable:true},
 cashCurrency:{type:String,enum:currencyCodes,required:true,immutable:true},
 providerPrincipalMinor:{type:D,required:true,immutable:true},physicalCashMinor:{type:D,required:true,immutable:true},
 rateSnapshot:{type:rate,required:true,immutable:true},
 walletAccountId:{type:O,default:null,immutable:true},cashAccountId:{type:O,required:true,immutable:true},
 destinationBranchId:{type:O,default:null,immutable:true},destinationPayoutAccountId:{type:O,default:null,immutable:true},
 // FinHub never guesses network fees/commission. This is a link to separately
 // verified pricing/commission evidence (not automatically recognized income).
 providerEvidenceId:{type:O,default:null},collectionEvidenceId:{type:O,default:null},
 payoutEvidenceId:{type:O,default:null},
 postingBatchIds:{type:[O],default:[]},realizedCostBasisEventId:{type:O,default:null},
 status:{type:String,enum:['quoted','pending_provider','collected','pending_payout','posted','reversed','disputed'],required:true,default:'quoted'},
 revision:{type:Number,default:0,min:0},
 occurredAt:{type:Date,default:null},postedAt:{type:Date,default:null},reversedAt:{type:Date,default:null},
 createdBy:{type:O,required:true,immutable:true}
},{strict:'throw',timestamps:true});
settlement.index({sourceModule:1,sourceId:1},{unique:true,name:'one_settlement_per_source_operation'});
settlement.index({idempotencyKey:1},{unique:true,name:'unique_linked_currency_settlement_request'});
settlement.index({tenantId:1,branchId:1,occurredAt:-1});
settlement.index({status:1,updatedAt:1});
const costBook=new Schema({
 tenantId:{type:O,required:true,immutable:true},branchId:{type:O,required:true,immutable:true},
 accountId:{type:O,required:true,immutable:true},foreignCurrency:{type:String,enum:currencyCodes,required:true,immutable:true},
 functionalCurrency:{type:String,enum:currencyCodes,required:true,immutable:true},
 unitsMinor:{type:D,required:true,default:'0'},costFunctionalMinor:{type:D,required:true,default:'0'},
 revision:{type:Number,default:0,min:0},lastSettlementId:{type:O,default:null}
},{strict:'throw',timestamps:true});
costBook.index({accountId:1},{unique:true,name:'one_cost_book_per_native_currency_account'});
function models(conn){
 return {
  settlement:conn.models.LinkedCurrencySettlementV1||conn.model('LinkedCurrencySettlementV1',settlement),
  costBook:conn.models.FxWeightedCostBookV1||conn.model('FxWeightedCostBookV1',costBook)
 };
}
module.exports={models,settlementSchema:settlement,costBookSchema:costBook};
