'use strict';
// One customer MoMo operation has two currency-specific custody legs:
// provider electronic float and physical settlement cash. Never convert
// a provider balance in place or silently treat SSP banknotes as UGX.
const {forexRateModel}=require('../models');
const fx=require('./forex.service');
const {currencies}=require('../../config/currencies');
const OID=/^[a-f0-9]{24}$/i;
function fail(message,status=409){return Object.assign(new Error(message),{status});}
function direction(operation){
 if(operation==='cash_out')return 'buy';  // acquire provider float, pay local cash
 if(operation==='cash_in')return 'sell';  // deliver provider float, receive local cash
 throw fail('Unsupported Mobile Money settlement direction',400);
}
function normalize(input,providerCurrency){
 const settlementCurrency=input?.settlementCurrency||providerCurrency;
 if(!Object.hasOwn(currencies,settlementCurrency))throw fail('Choose a supported physical settlement currency',400);
 const crossCurrency=settlementCurrency!==providerCurrency;
 const forexRateId=String(input?.forexRateId||'').trim();
 const amount=input?.settlementAmount==null?'':String(input.settlementAmount).trim();
 if(!crossCurrency){
  if(forexRateId||amount)throw fail('A same-currency transaction does not use a foreign-exchange settlement amount',400);
  return {settlementCurrency,forexRateId:null,settlementAmountMinor:null,crossCurrency:false};
 }
 if(!OID.test(forexRateId))throw fail('Choose an active approved exchange rate for this physical cash currency',409);
 const {toMinor}=require('./mobileMoney.service');
 const settlementAmountMinor=toMinor(amount,settlementCurrency);
 return {settlementCurrency,forexRateId,settlementAmountMinor,crossCurrency:true};
}
function pricingSnapshot(values,rate,branchId,now=new Date()){
 const side=direction(values.operation);
 if(!rate||String(rate._id)!==String(values.forexRateId)||
    String(rate.branchId)!==String(branchId)||rate.status!=='active'||
    rate.side!==side||rate.fromCurrency!==values.currency||
    rate.toCurrency!==values.settlementCurrency||
    !rate.expiresAt||new Date(rate.expiresAt)<=now)
  throw fail('Approved exchange rate changed or expired. Reload the transaction and confirm the actual cash amount.',409);
 if(values.paymentMethod!=='Cash')throw fail('Cross-currency settlement must use an actual physical cash drawer',400);
 if(values.feeTreatment!=='record_only')
  throw fail('Cross-currency Mobile Money requires Record only fee treatment. Customer fees and commissions need their own verified currency-specific entry.',409);
 const expected=fx.converted(BigInt(values.amountMinor),values.currency,values.settlementCurrency,fx.rateScaled(String(rate.rateDecimal)));
 if(BigInt(values.settlementAmountMinor)!==expected)
  throw fail('The recorded physical cash amount does not match the approved exchange rate. Reload and verify the amount actually paid or received.',409);
 return {settlementCurrency:values.settlementCurrency,settlementAmountMinor:String(expected),
  forexRateId:rate._id,forexRateDecimal:String(rate.rateDecimal),forexSide:side,crossCurrency:true};
}
async function resolve(conn,session,branchId,values){
 if(!values.crossCurrency)return {settlementCurrency:values.currency,
   settlementAmountMinor:String(values.amountMinor),forexRateId:null,forexRateDecimal:null,forexSide:null,crossCurrency:false};
 const Rate=forexRateModel(conn);
 const rate=await Rate.findOne({_id:values.forexRateId,branchId,
   fromCurrency:values.currency,toCurrency:values.settlementCurrency,
   side:direction(values.operation),status:'active',expiresAt:{$gt:new Date()}}).session(session).lean();
 return pricingSnapshot(values,rate,branchId);
}
module.exports={fail,direction,normalize,pricingSnapshot,resolve};
