'use strict';
// Exact financial journal contracts for a *future* linked currency posting.
// No writing, no balancing via currency conversion, no fiat rate inference.
// A real posting implementation must use the same tenant DB transaction as
// source record, rate revalidation, account updates and cost-basis allocation.
const {integer,fail}=require('./planner');
function linesForMoMo(plan){
 if(plan?.channel!=='mobile_money'||plan.custodyLegs?.length!==2)
  throw fail('Only a validated Mobile Money native-currency plan can be journaled',400);
 const [wallet,cash]=plan.custodyLegs;
 if(wallet.kind!=='wallet'||cash.kind!=='cash'||wallet.currency===cash.currency||
    wallet.currency!==plan.providerCurrency||cash.currency!==plan.cashCurrency)
  throw fail('Provider float and physical cash must remain in separate native currency books');
 if(wallet.accountId===cash.accountId)throw fail('A cash account cannot be the provider wallet');
 const entries=[];
 for(const leg of [wallet,cash]){
  const delta=BigInt(leg.deltaMinor);
  if(!delta||leg.deltaMinor!==String(delta))throw fail('Custody movement requires an exact nonzero amount');
  const qty=delta<0n?-delta:delta;
  const assetSide=delta>0n?'debit':'credit';
  entries.push(Object.freeze({
   branchId:plan.branchId,currency:leg.currency,
   kind:leg.kind,accountId:leg.accountId,side:assetSide,amountMinor:String(qty)
  }));
  entries.push(Object.freeze({
   branchId:plan.branchId,currency:leg.currency,
   kind:'fx_settlement_clearing',accountId:null,
   side:delta>0n?'credit':'debit',amountMinor:String(qty)
  }));
 }
 assertBalanced(entries);
 return Object.freeze(entries);
}
function assertBalanced(entries){
 if(!Array.isArray(entries)||!entries.length)throw fail('Journal is empty');
 const net=new Map();
 for(const entry of entries){
  if(!['debit','credit'].includes(entry.side))throw fail('Invalid journal line side');
  const amount=integer(entry.amountMinor,'journal amount');
  if(typeof entry.currency!=='string'||!entry.currency)throw fail('Missing journal currency');
  const key=String(entry.branchId)+':'+entry.currency;
  net.set(key,(net.get(key)||0n)+(entry.side==='debit'?amount:-amount));
 }
 for(const [key,balance] of net)if(balance!==0n)throw fail('Currency journal is not balanced for '+key);
 return true;
}
function transferStages(plan){
 if(plan?.channel!=='money_transfer'||plan.status!=='quote_only_no_funds_posted')
  throw fail('A staged transfer plan is required');
 const collection=plan.collectionStage,payout=plan.payoutStage;
 if(collection.currency===payout.currency||collection.accountId===payout.accountId||
    BigInt(collection.deltaMinor)<=0n||BigInt(payout.deltaMinor)>=0n)
  throw fail('Expected distinct collection and destination payout obligations');
 // Neither stage may move funds until provider evidence and the specific
 // branch payable/receivable FX clearing are confirmed in a DB transaction.
 return Object.freeze([
  Object.freeze({stage:'collection',branchId:collection.branchId,currency:collection.currency,
   cashAccountId:collection.accountId,deltaMinor:collection.deltaMinor,
   event:'verified_cash_collected',status:'not_posted'}),
  Object.freeze({stage:'payout',branchId:payout.branchId,currency:payout.currency,
   payoutAccountId:payout.accountId,deltaMinor:payout.deltaMinor,
   event:'verified_beneficiary_paid',status:'not_posted'})
 ]);
}
function reversalEntries(postedEntries){
 if(!assertBalanced(postedEntries))throw fail('Unbalanced original transaction cannot be reversed');
 const reversed=postedEntries.map(line=>Object.freeze({...line,side:line.side==='debit'?'credit':'debit'}));
 assertBalanced(reversed);
 return Object.freeze(reversed);
}
module.exports={linesForMoMo,assertBalanced,transferStages,reversalEntries};
