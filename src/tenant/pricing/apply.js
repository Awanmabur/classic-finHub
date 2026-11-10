'use strict';
// Fee values are derived from persisted configuration inside the operation's
// existing transaction. Estimated costs remain metadata, never ledger entries.
function fail(message,status=400){return Object.assign(Error(message),{status});}
function mode(input){
 if(input?.pricingMode!==undefined&&input.pricingMode!=='configured')throw fail('Reload the form to use configured charges.');
 return input?.pricingMode==='configured';
}
function token(value){return value?.policyId?`${value.policyId}:${value.revision}`:'default';}
function zero(operation,currency){return {policyId:null,revision:0,operation,currency,feeMinor:'0',costMinor:'0',fixedFeeMinor:'0',feeBps:0,fixedCostMinor:'0',costBps:0};}
function decimal(minor,currency){
 const scale=require('../../config/currencies').forexCurrencies[currency];
 if(scale===undefined)throw fail('Unsupported charge currency.');
 const text=String(minor),size=10n**BigInt(scale),number=BigInt(text);
 return scale?`${number/size}.${String(number%size).padStart(scale,'0')}`:text;
}
function assertToken(input,pricing){
 if(mode(input)&&input.pricingPolicy!==token(pricing))throw fail('Charges changed since this form was prepared. Review the current fees before submitting this saved entry.',409);
}
function assertFee(input,pricing,{field='fee',providedMinor}={}){
 if(mode(input))return; // A preview is never authority for configured charges.
 if(input?.[field]!==undefined&&input[field]!==''&&providedMinor!==undefined&&String(providedMinor)!==String(pricing.feeMinor))throw fail('Charges are set by the workspace. Reload the form to use the configured fee.',409);
}
async function resolve(conn,tenant,branch,input,{operation,currency,amountMinor,network='',session=null,existing=null,providedMinor,field='fee',source='manual'}={}){
 const configured=mode(input);
 // Provider-captured fees remain the original external evidence. A pricing
 // policy must not silently replace an amount actually reported in an SMS.
 if(source==='sms'&&!configured)return null;
 if(existing){
  if(existing.pricing){const pricing={...existing.pricing};assertToken(input,pricing);assertFee(input,pricing,{field,providedMinor});return pricing;}
  return null; // Preserve historical records and their original input semantics.
 }
 const service=require('./service');
 const rules=await service.context(conn,tenant,branch,{session});
 const rule=service.select(rules,{operation,currency,network,branchId:String(branch?._id||branch||'')});
 if(!rule&&!configured)return null;
 const pricing=rule?service.snapshot(rule,BigInt(amountMinor),currency):zero(operation,currency);
 assertToken(input,pricing);assertFee(input,pricing,{field,providedMinor});
 return pricing;
}
module.exports={mode,token,zero,decimal,resolve,assertToken,assertFee};
