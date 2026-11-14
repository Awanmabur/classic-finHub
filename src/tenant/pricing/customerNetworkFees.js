'use strict';
// PUBLIC CUSTOMER CHARGES, not agent commission. Never use for ledger posting.
// Provider pages can change or retain historical tables; every quote is reference only.
const mtnBands=[
 [500,2500,100,null,330,110,190],
 [2501,5000,100,1500,440,150,600],
 [5001,15000,500,1500,700,550,1000],
 [15001,30000,500,1500,880,650,1600],
 [30001,45000,500,1500,1210,750,2100],
 [45001,60000,500,1500,1500,850,2800],
 [60001,125000,1000,1500,1925,950,3700],
 [125001,250000,1000,2250,3575,1050,4150],
 [250001,500000,1000,4100,7000,1300,5300],
 [500001,1000000,1500,6150,12500,3350,6300],
 [1000001,2000000,2000,9250,15000,5750,6300],
 [2000001,4000000,2000,11300,18000,5750,6300],
 [4000001,5000000,2000,11300,20000,5750,6300]
];
const airtelBands=[
 [0,2500,100,330],
 [2501,5000,100,440],
 [5001,15000,500,700],
 [15001,30000,500,880],
 [30001,45000,500,1210],
 [45001,60000,500,1500],
 [60001,125000,1000,1925],
 [125001,250000,1000,3575],
 [250001,500000,1000,7000],
 [500001,1000000,1500,12500],
 [1000001,2000000,2000,15000],
 [2000001,3000000,2000,18000],
 [3000001,4000000,2000,18000],
 [4000001,5000000,2000,18000]
];
const TABLES=Object.freeze([
 Object.freeze({
  network:'MTN',country:'UG',currency:'UGX',label:'MTN MoMo Uganda',
  source:'https://www.mtn.co.ug/tariffs/mobile-money-tariffs/',
  checkedOn:'2026-11-14',sourceEffectiveDate:null,
  status:'published_reference',depositFeeMinor:'0',
  operations:[
   ['send','Send to MTN or other networks'],
   ['send_bank','Send to bank account'],
   ['cash_out','Withdraw cash at an agent'],
   ['bill_payment','Selected bill payments'],
   ['bill_payment_utilities','Utilities and other bill payments']
  ].map(([key,label])=>({key,label})),
  bands:mtnBands.map(([min,max,send,sendBank,cashOut,bill,billUtilities])=>({
   minMinor:String(min),maxMinor:String(max),
   charges:{send:String(send),send_bank:sendBank===null?null:String(sendBank),
    cash_out:String(cashOut),bill_payment:String(bill),bill_payment_utilities:String(billUtilities)}
  })),
  note:'Official table lists additional withdrawal tax separately. Do not add network customer charges to agent commission or accept payment to the agent for customer transaction fees.'
 }),
 Object.freeze({
  network:'Airtel',country:'UG',currency:'UGX',label:'Airtel Money Uganda',
  source:'https://www.airtelmoney.ug/transaction_fees',
  checkedOn:'2026-11-14',sourceEffectiveDate:'2020-05-26',
  status:'historical_source_unverified',depositFeeMinor:'0',
  operations:[{key:'send',label:'Send to Airtel or MTN'},{key:'cash_out',label:'Withdraw cash at an agent'}],
  bands:airtelBands.map(([min,max,send,cashOut])=>({minMinor:String(min),maxMinor:String(max),charges:{send:String(send),cash_out:String(cashOut)}})),
  note:'Airtel page retains an old effective-date notice. These numbers require current provider confirmation before quoting customers or configuring charges. Withdrawal tax is separate.'
 })
]);
function quote(network,operation,amountMinor){
 if(typeof amountMinor!=='string'||!/^(?:0|[1-9][0-9]{0,17})$/.test(amountMinor))throw Object.assign(new Error('Invalid reference amount'),{status:400});
 const table=TABLES.find(row=>row.network===network);
 if(!table)return {status:'provider_tariff_unknown',postsToLedger:false};
 if(operation==='cash_in')return {network,operation,amountMinor,customerFeeMinor:table.depositFeeMinor,status:table.status,postsToLedger:false};
 const tier=table.bands.find(b=>BigInt(amountMinor)>=BigInt(b.minMinor)&&BigInt(amountMinor)<=BigInt(b.maxMinor));
 const value=tier?.charges?.[operation];
 if(value===undefined||value===null)return {network,operation,amountMinor,status:'no_rate',postsToLedger:false};
 return {network,operation,amountMinor,customerFeeMinor:value,status:table.status,postsToLedger:false};
}
module.exports={TABLES,quote};
