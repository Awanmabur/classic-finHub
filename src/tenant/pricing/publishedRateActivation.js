'use strict';
// Use checked-in provider tables as rate-band data. No operator retyping.
// Activation means OWNER-AUTHORIZED NON-POSTING ESTIMATES, not provider verification.
const customer=require('./customerNetworkFees');
const agent=require('./networkTariffs');
function error(message,status=409){return Object.assign(new Error(message),{status});}
const currency='UGX';
const operations=['cash_in','cash_out'];
function templates(network,scheduleKind){
 if(scheduleKind==='all'){
  if(network!=='MTN')throw error('A complete currently approved built-in sheet is only available for MTN Uganda');
  return [...templates(network,'agent_commission'),...templates(network,'customer_network_fee')];
 }
 if(scheduleKind==='customer_network_fee'){
  const table=customer.TABLES.find(row=>row.network===network&&row.currency===currency);
  if(!table)throw error('No built-in provider customer fee sheet is available for this market');
  if(table.status!=='published_reference')throw error('This provider table contains historical/unverified rates. Confirm an up-to-date provider sheet before activating it as an approved schedule.');
  return operations.map(operation=>{
   const tiers=operation==='cash_in'
    ?[{minMinor:'1',maxMinor:'5000000',rate:{kind:'flat',value:table.depositFeeMinor}}]
    :table.bands.filter(row=>row.charges.cash_out!==null&&row.charges.cash_out!==undefined)
      .map(row=>({minMinor:row.minMinor,maxMinor:row.maxMinor,rate:{kind:'flat',value:row.charges.cash_out}}));
   if(!tiers.length)throw error('This provider table has no supported rates');
   const result={network,currency:table.currency,operation,scheduleKind,tiers,
    sourceUrl:table.source,checkedOn:table.checkedOn,sourceStatus:table.status};
   agent.validateTariff({...result,status:'draft'});
   return result;
  });
 }
 if(scheduleKind==='agent_commission'&&network==='MTN'){
  return operations.map(operation=>{
   const rate=agent.publicAgentReference(operation);
   agent.validateTariff(rate);
   return {network,currency,operation,scheduleKind,tiers:rate.tiers,
    sourceUrl:rate.providerEvidence,checkedOn:rate.reviewedOn,sourceStatus:'published_reference'};
  });
 }
 throw error('This provider has no separately published agent commission sheet to activate');
}
module.exports={templates};
