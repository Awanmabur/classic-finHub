'use strict';
// Non-posting reference schedule. Never treats customer tariff as agent income.
// These are reviewed published rates, NOT an assertion of current payout.
const source={
  network:'MTN',country:'UG',currency:'UGX',kind:'agent_commission',
  sourceUrl:'https://www.mtn.co.ug/momo/agent/',checkedOn:'2026-11-14',
  effectiveFrom:null,providerConfirmed:false,
  status:'reference_only',
  // From the public agent commission table (UGX bands).
  tiers:[
    [500,2500,'percent',400,'flat',100],
    [2501,5000,'flat',110,'flat',120],
    [5001,15000,'flat',175,'flat',200],
    [15001,30000,'flat',225,'flat',275],
    [30001,45000,'flat',275,'flat',360],
    [45001,60000,'flat',325,'flat',450],
    [60001,125000,'flat',400,'flat',600],
    [125001,250000,'flat',500,'flat',1000],
    [250001,500000,'flat',950,'flat',2000],
    [500001,1000000,'flat',1600,'flat',3900],
    [1000001,2000000,'flat',3000,'flat',4400],
    [2000001,4000000,'flat',3000,'flat',4500],
    [4000001,7000000,'flat',3000,'flat',5000]
  ].map(([min,max,depositMode,depositValue,withdrawMode,withdrawValue])=>({
    minMinor:String(min),maxMinor:String(max),
    cash_in:{mode:depositMode,value:String(depositValue)},
    cash_out:{mode:withdrawMode,value:String(withdrawValue)}
  }))
};
const NETWORKS=Object.freeze({
  MTN:{country:'UG',currency:'UGX',displayName:'MTN MoMo Uganda'},
  'MTN SSD':{country:'SS',currency:'SSP',displayName:'MTN MoMo South Sudan'},
  Airtel:{country:'UG',currency:'UGX',displayName:'Airtel Money Uganda'},
  Africell:{country:null,currency:null,displayName:'Africell Money — verify market'},
  'M-Pesa':{country:null,currency:null,displayName:'M-Pesa — select local market'}
});
function invalid(message){throw Object.assign(new Error(message),{status:422});}
function integer(value,{positive=false}={}){
  if(typeof value!=='string'||! /^(?:0|[1-9][0-9]{0,17})$/.test(value))invalid('Amount must be an exact non-negative integer minor-unit string');
  const n=BigInt(value);
  if(positive&&n===0n)invalid('Amount must be positive');
  return n;
}
const OPERATIONS=Object.freeze(['cash_in','cash_out','send','bill_payment','airtime_sale','merchant_payment']);
const SCHEDULE_KINDS=Object.freeze(['agent_commission','customer_network_fee']);
function validateTariff(input){
  if(!input||typeof input!=='object'||Array.isArray(input))invalid('Invalid tariff schedule');
  if(!Object.hasOwn(NETWORKS,input.network)||!OPERATIONS.includes(input.operation))invalid('Invalid provider or agent operation');
  const network=NETWORKS[input.network];
  if(!network.currency||input.currency!==network.currency)invalid('Provider currency mismatch');
  if(!['draft','verified','retired'].includes(input.status))invalid('Invalid tariff status');
  if(input.status==='verified'&&(!input.providerEvidence||!input.effectiveFrom))invalid('A verified tariff needs provider evidence and effective start date');
  if(!Array.isArray(input.tiers)||input.tiers.length<1||input.tiers.length>250)invalid('Enter 1–250 amount bands');
  let previous=0n;
  for(const tier of input.tiers){
    const low=integer(tier.minMinor,{positive:true}),high=integer(tier.maxMinor,{positive:true});
    if(high<low||low<=previous)invalid('Tariff bands cannot overlap or be out of order');
    const rate=tier.rate;
    if(!rate||!['flat','basis_points'].includes(rate.kind))invalid('Invalid commission calculation');
    const value=integer(rate.value);
    if(rate.kind==='basis_points'&&value>10000n)invalid('Percentage must not exceed 100 percent');
    previous=high;
  }
  return true;
}
function quote(input,amountMinor){
  validateTariff(input);
  const amount=integer(amountMinor,{positive:true});
  const tier=input.tiers.find(t=>amount>=BigInt(t.minMinor)&&amount<=BigInt(t.maxMinor));
  if(!tier)return {status:'no_matching_band',amountMinor:String(amount),currency:input.currency};
  const value=BigInt(tier.rate.value);
  const commission=tier.rate.kind==='flat'?value:(amount*value+5000n)/10000n;
  return {
    status:input.status==='verified'?'verified_schedule_estimate':'unverified_schedule_estimate',
    network:input.network,operation:input.operation,currency:input.currency,
    amountMinor:String(amount),grossCommissionEstimateMinor:String(commission),
    tier:{minMinor:tier.minMinor,maxMinor:tier.maxMinor},
    // Deliberately never output accounting journal lines or settled profit.
    postsToLedger:false,requiresProviderSettlement:true
  };
}
function publicAgentReference(operation){
  if(!['cash_in','cash_out'].includes(operation))invalid('Unsupported operation');
  return {
    network:source.network,currency:source.currency,operation,status:'draft',
    providerEvidence:source.sourceUrl,effectiveFrom:null,
    reviewedOn:source.checkedOn,
    tiers:source.tiers.map(row=>({
      minMinor:row.minMinor,maxMinor:row.maxMinor,
      rate:{kind:row[operation].mode==='percent'?'basis_points':'flat',value:row[operation].value}
    }))
  };
}
module.exports={NETWORKS,OPERATIONS,SCHEDULE_KINDS,publicAgentReference,validateTariff,quote};
