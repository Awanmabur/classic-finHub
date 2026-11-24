'use strict';
// Pure, read-only two-currency quote calculation. This does NOT post a journal,
// confirm a provider payment or authorize cross-border currency dealing.
const {currencies}=require('../../config/currencies');
const MAX=999999999999999999n;
function fail(message){return Object.assign(new Error(message),{status:400});}
function iso(code){
 if(typeof code!=='string'||!Object.hasOwn(currencies,code))throw fail('Unsupported currency');
 return code;
}
function positiveMinor(value,label){
 if(typeof value!=='string'||!/^[1-9][0-9]{0,17}$/.test(value)||BigInt(value)>MAX)throw fail('Invalid '+label+' minor amount');
 return BigInt(value);
}
function rateParts(value){
 if(typeof value!=='string'||!/^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,8})?$/.test(value))throw fail('Invalid approved exchange rate');
 const [whole,fraction='']=value.split('.');
 const n=BigInt(whole)*100000000n+BigInt(fraction.padEnd(8,'0'));
 if(n===0n)throw fail('Exchange rate must be positive');
 return n;
}
function quote(input,{now=Date.now()}={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw fail('Invalid exchange request');
 const {operation,providerCurrency,cashCurrency,providerAmountMinor,cashAmountMinor,rateDecimal,rateSide,rateId,rateVersion,approved,expiresAt}=input;
 if(!['withdraw_provider_receive_cash','deposit_cash_send_provider'].includes(operation))throw fail('Invalid exchange direction');
 const foreign=iso(providerCurrency),cash=iso(cashCurrency);
 if(foreign===cash)throw fail('Cross-currency exchange needs two different currencies');
 const expected=operation==='withdraw_provider_receive_cash'?'buy':'sell';
 if(rateSide!==expected)throw fail('Wrong approved Buy/Sell side for exchange direction');
 if(approved!==true||typeof rateId!=='string'||!/^[a-f0-9]{24}$/i.test(rateId)
   ||!Number.isSafeInteger(rateVersion)||rateVersion<1)throw fail('Current approved rate is required');
 if(typeof expiresAt!=='string'||!Number.isFinite(Date.parse(expiresAt))||Date.parse(expiresAt)<=now)
   throw fail('Approved exchange rate has expired');
 const rate=rateParts(rateDecimal);
 // Rate convention: one whole provider unit equals rateDecimal whole cash units.
 // Deposit starts with the ACTUAL cash received. Convert inversely and round
 // the wallet payout to its native minor unit; never replace counted cash with
 // a reverse-calculated approximation.
 const depositFromCash=expected==='sell'&&cashAmountMinor!==undefined;
 let n,cashMinor;
 if(depositFromCash){
  cashMinor=positiveMinor(cashAmountMinor,'cash');
  const numerator=cashMinor*100000000n*10n**BigInt(currencies[foreign]);
  const denominator=rate*10n**BigInt(currencies[cash]);
  n=(numerator+denominator/2n)/denominator;
  if(n<=0n||n>MAX)throw fail('Cash amount converts to zero or exceeds provider limits');
  if(providerAmountMinor!==undefined&&positiveMinor(providerAmountMinor,'provider')!==n)
   throw fail('Provider amount does not match the approved cash-first deposit quote');
 }else{
  n=positiveMinor(providerAmountMinor,'provider');
  const numerator=n*rate*10n**BigInt(currencies[cash]);
  const denominator=100000000n*10n**BigInt(currencies[foreign]);
  cashMinor=(numerator+denominator/2n)/denominator;
  if(cashMinor<=0n||cashMinor>MAX)throw fail('Calculated cash payout is out of range');
 }
 const withdrawal=expected==='buy';
 return Object.freeze({
  operation,providerCurrency:foreign,cashCurrency:cash,rateSide:expected,
  rateId,rateVersion,rateDecimal,providerAmountMinor:n.toString(),
  cashAmountMinor:cashMinor.toString(),
  // Signed from agent perspective; never conflate wallet and physical cash.
  walletDeltaMinor:(withdrawal?n:-n).toString(),
  cashDeltaMinor:(withdrawal?-cashMinor:cashMinor).toString(),
  providerSettlementVerified:false,postingAuthorized:false,
  note:'Preview only. Actual provider result, approved rights and atomic journal are required before posting.'
 });
}
module.exports={quote};
