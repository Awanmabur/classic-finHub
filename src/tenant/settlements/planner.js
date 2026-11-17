'use strict';
// Shared *planning* engine for cross-currency MoMo and Money Transfer.
//
// This file NEVER mutates a wallet, cash drawer, cost lot or journal. A quote is
// not a posted transaction. The channel's actual execution must atomically
// validate provider evidence, revalidate rates and post exact cash/float +
// payable/clearing journals under the tenant's database transaction.
const {currencies,currencyCodes}=require('../../config/currencies');
const {rateScaled,converted}=require('../services/forex.service');
const OID=/^[0-9a-f]{24}$/i;
const AMOUNT=/^(?:0|[1-9][0-9]{0,17})$/;
function fail(message,status=409){return Object.assign(new Error(message),{status});}
function currency(value){
 if(!currencyCodes.includes(value))throw fail('Choose a supported native settlement currency',400);
 return value;
}
function integer(value,label,{allowZero=false}={}){
 const s=String(value??'');
 if(!AMOUNT.test(s)||(!allowZero&&s==='0'))throw fail(`Invalid exact ${label} minor units`,400);
 return BigInt(s);
}
function objectId(value,label){
 if(!OID.test(String(value||'')))throw fail(`Invalid ${label}`,400);
 return String(value).toLowerCase();
}
function rateSnapshot(rate,{branchId,fromCurrency,toCurrency,side,at=new Date()}){
 if(!rate||rate.side!==side||rate.fromCurrency!==currency(fromCurrency)||
  rate.toCurrency!==currency(toCurrency)||String(rate.branchId)!==String(branchId)||
  rate.status!=='active'||!rate.reviewedBy||!rate.reviewedAt||String(rate.reviewedBy)===String(rate.proposedBy)||!OID.test(String(rate._id||''))||
  !rate.expiresAt||new Date(rate.expiresAt).getTime()<=new Date(at).getTime()||
  !Number.isFinite(new Date(rate.expiresAt).getTime()))
  throw fail('A matching, independently approved, unexpired currency rate is required');
 const value=String(rate.rateDecimal||'');
 const scaled=rateScaled(value);
 return Object.freeze({
  rateId:objectId(rate._id,'approved exchange rate'),
  fromCurrency,toCurrency,side,rateDecimal:value,rateScaled:String(scaled),
  approvedBy:objectId(rate.reviewedBy,'rate reviewer'),branchId:objectId(branchId,'rate branch'),
  expiresAt:new Date(rate.expiresAt).toISOString()
 });
}
function quote({channel,operation,branchId,providerCurrency,cashCurrency,providerPrincipalMinor,
 cashAccountId,walletAccountId,rate,at}={}){
 if(channel!=='mobile_money')throw fail('Use the staged-transfer planner for Money Transfer',400);
 if(!['cash_in','cash_out'].includes(operation))throw fail('Choose deposit or withdrawal',400);
 objectId(branchId,'settlement branch');
 objectId(cashAccountId,'physical cash account');
 objectId(walletAccountId,'provider float account');
 if(String(cashAccountId)===String(walletAccountId))throw fail('Cash and provider float must be different accounts',400);
 currency(providerCurrency);currency(cashCurrency);
 const principal=integer(providerPrincipalMinor,'provider principal');
 if(providerCurrency===cashCurrency)throw fail('Use the existing same-currency MoMo posting path; no Forex conversion is needed',400);
 const side=operation==='cash_out'?'buy':'sell'; // from the agent's perspective: buying/selling provider currency
 const approved=rateSnapshot(rate,{branchId,fromCurrency:providerCurrency,toCurrency:cashCurrency,side,at});
 const cash=converted(principal,providerCurrency,cashCurrency,BigInt(approved.rateScaled));
 const walletDelta=operation==='cash_out'?principal:-principal;
 const cashDelta=operation==='cash_out'?-cash:cash;
 return Object.freeze({
  channel,operation,branchId:objectId(branchId,'branch'),
  rateSnapshot:approved,providerCurrency,cashCurrency,
  providerPrincipalMinor:String(principal),actualCashMinor:String(cash),
  custodyLegs:Object.freeze([
   Object.freeze({accountId:objectId(walletAccountId,'provider float account'),kind:'wallet',currency:providerCurrency,deltaMinor:String(walletDelta)}),
   Object.freeze({accountId:objectId(cashAccountId,'physical cash account'),kind:'cash',currency:cashCurrency,deltaMinor:String(cashDelta)})
  ]),
  profitStatus:'unmeasured_without_verified_cost_basis',
  providerConfirmationStatus:'unverified',
  feeTreatment:'separate_provider_evidence'
 });
}
function transferPlan({originBranchId,destinationBranchId,originCashAccountId,destinationPayoutAccountId,
 collectionCurrency,payoutCurrency,payoutMinor,rate,at}={}){
 const origin=objectId(originBranchId,'origin branch'),destination=objectId(destinationBranchId,'destination branch');
 if(origin===destination)throw fail('Use a same-branch transfer operation instead',400);
 objectId(originCashAccountId,'origin cash account');objectId(destinationPayoutAccountId,'destination payout account');
 currency(collectionCurrency);currency(payoutCurrency);
 if(collectionCurrency===payoutCurrency)
  throw fail('Use the existing same-currency transfer workflow',400);
 const amount=integer(payoutMinor,'recipient payout');
 // Selling foreign payout currency for locally collected cash.
 const approved=rateSnapshot(rate,{branchId:origin,fromCurrency:payoutCurrency,toCurrency:collectionCurrency,side:'sell',at});
 const cash=converted(amount,payoutCurrency,collectionCurrency,BigInt(approved.rateScaled));
 return Object.freeze({
  channel:'money_transfer',operation:'transfer_cross_currency',
  originBranchId:origin,destinationBranchId:destination,rateSnapshot:approved,
  collectionCurrency,payoutCurrency,collectionCashMinor:String(cash),recipientPayoutMinor:String(amount),
  collectionStage:Object.freeze({branchId:origin,accountId:objectId(originCashAccountId,'origin cash account'),
   currency:collectionCurrency,deltaMinor:String(cash),obligation:'unpaid_recipient_liability'}),
  payoutStage:Object.freeze({branchId:destination,accountId:objectId(destinationPayoutAccountId,'destination payout account'),
   currency:payoutCurrency,deltaMinor:String(-amount),obligation:'release_only_after_verified_collection'}),
  status:'quote_only_no_funds_posted',
  profitStatus:'unmeasured_without_verified_cost_basis',
  note:'Origin collection and destination payout need separate verified events and balanced interbranch liabilities. Neither leg is executed by this plan.'
 });
}
function weightedAverageDisposal({holdingMinor,acquisitionCostFunctionalMinor,disposedMinor,
 proceedsFunctionalMinor}={}){
 const holding=integer(holdingMinor,'holding'),cost=integer(acquisitionCostFunctionalMinor,'acquisition cost',{allowZero:true}),
 disposed=integer(disposedMinor,'disposed units'),proceeds=integer(proceedsFunctionalMinor,'proceeds',{allowZero:true});
 if(disposed>holding)throw fail('Cannot dispose more foreign currency than the verified cost-basis holding');
 // Exact functional-currency minor units with half-up allocation for partial disposals.
 // Disposing the remaining units takes the entire residual cost (no drift).
 const consumed=disposed===holding?cost:(cost*disposed+holding/2n)/holding;
 return Object.freeze({
  disposedMinor:String(disposed),costConsumedFunctionalMinor:String(consumed),
  remainingHoldingMinor:String(holding-disposed),
  remainingCostFunctionalMinor:String(cost-consumed),
  grossRealizedResultFunctionalMinor:String(proceeds-consumed),
  status:'cost_basis_matched',netProfitNotComputed:true
 });
}
function weightedAverageAcquisition({holdingMinor='0',acquisitionCostFunctionalMinor='0',acquiredMinor,paidFunctionalMinor}={}){
 const holding=integer(holdingMinor,'prior holding',{allowZero:true});
 const cost=integer(acquisitionCostFunctionalMinor,'prior acquisition cost',{allowZero:true});
 const acquired=integer(acquiredMinor,'acquired foreign units');
 const paid=integer(paidFunctionalMinor,'documented purchase cost',{allowZero:true});
 if(cost===0n&&holding!==0n)throw fail('Cannot value an existing foreign holding without a verified opening acquisition cost');
 return Object.freeze({holdingMinor:String(holding+acquired),costFunctionalMinor:String(cost+paid),
  acquiredMinor:String(acquired),documentedPurchaseCostFunctionalMinor:String(paid),
  grossProfitNotRecognized:true});
}
module.exports={fail,currency,integer,objectId,rateSnapshot,quote,transferPlan,weightedAverageDisposal,weightedAverageAcquisition};
