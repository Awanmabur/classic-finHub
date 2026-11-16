'use strict';
// Informational snapshots of the exact public table used at transaction time.
// These are never approved tenant rates and never generate agent income.
const reference=require('./networkTariffs');
const customer=require('./customerNetworkFees');
function quote({network,operation,currency,amountMinor,at=new Date()}){
 const instant=new Date(at);
 if(!Number.isFinite(instant.getTime()))throw new RangeError('Invalid quote date');
 const input=String(amountMinor);
 const result={agentCommissionPublishedReference:null,customerNetworkChargePublishedReference:null};
 if(network==='MTN'&&currency==='UGX'&&['cash_in','cash_out'].includes(operation)){
  const sheet=reference.publicAgentReference(operation);
  const calculated=reference.quote(sheet,input);
  if(calculated.grossCommissionEstimateMinor!=null&&calculated.status==='unverified_schedule_estimate'){
   result.agentCommissionPublishedReference={
    network,operation,currency,amountMinor:String(calculated.grossCommissionEstimateMinor),
    sourceUrl:sheet.providerEvidence,checkedOn:sheet.reviewedOn,quotedAt:instant,status:'reference_only'
   };
  }
 }
 const table=customer.TABLES.find(x=>x.network===network&&x.currency===currency);
 if(table&&['published_reference','historical_source_unverified'].includes(table.status)){
  const calculated=customer.quote(network,operation,input);
  if(calculated.customerFeeMinor!=null&&calculated.status===table.status)
   result.customerNetworkChargePublishedReference={
    network,operation,currency,amountMinor:String(calculated.customerFeeMinor),
    sourceUrl:table.source,checkedOn:table.checkedOn,quotedAt:instant,
    status:table.status==='published_reference'?'reference_only':'historical_unverified'
   };
 }
 return result;
}
module.exports={quote};
