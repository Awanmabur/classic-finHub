'use strict';
// Ledger-sourced, authenticated manual posting receipt. No transfer PIN,
// decrypted secret, identity document or provider-settlement claim is printed.
const businessTime=require('../../utils/businessTime');
const format=require('../services/mobileMoney.service').formatMoneyMinor;
const {branchModel}=require('../models');
function fail(message,status=409){return Object.assign(new Error(message),{status});}
async function fromDetail(conn,tenant,detail){
 const row=detail?.execution,s=row?.sourceSnapshot;
 if(!row||row.status!=='posted_manual'||!Array.isArray(row.journalIds)||!row.journalIds.length||!s)
  throw fail('A receipt is available only after the financial movement is posted in the books');
 const branch=await branchModel(conn).findOne({_id:row.branchId,status:'active'}).select('name currency timeZone').lean();
 const zone=businessTime.forBranch(branch);
 const lines=[];
 let partyLabel='Customer',party='Customer account or walk-in customer';
 const money=(value,currency)=>format(value,currency);
 if(row.sourceType==='forex'){
  lines.push(['Original currency',money(s.sourceMinor,s.fromCurrency)],
   ['Customer settlement',money(s.targetMinor,s.toCurrency)],
   ['Recorded exchange rate',String(s.rateDecimal)]);
  if(BigInt(String(s.feeMinor||'0'))!==0n)lines.push(['Recorded commission',money(s.feeMinor,s.toCurrency)]);
  party='Walk-in currency exchange';
 }else{
  lines.push(['Recorded amount',money(s.amountMinor,s.currency)]);
  if(BigInt(String(s.feeMinor||'0'))!==0n)lines.push(['Recorded fee',money(s.feeMinor,s.currency)]);
  if(row.sourceType==='money_transfer'){
   partyLabel='Receiver';party=String(s.receiverName||'Receiver details held with original transfer');
   lines.push(['Transfer stage',row.action==='transfer_collect'?'Cash collection posted; payout pending':'Receiver payout posted']);
   if(row.payoutFx)lines.push(['Receiver cash paid',money(row.payoutFx.payoutMinor,row.payoutFx.targetCurrency)]);
  }else if(row.sourceType==='banking'){
   partyLabel='Account operation';party=String(s.kind||'Banking instruction').replaceAll('_',' ');
  }
 }
 lines.unshift(['Source reference',String(row.sourceReference)]);
 lines.push(['Checked evidence reference',String(row.evidenceReference)]);
 return {
  documentType:row.sourceType==='money_transfer'?
    (row.action==='transfer_collect'?'Transfer collection acknowledgement':'Transfer payout acknowledgement'):
    row.sourceType==='forex'?'Currency exchange acknowledgement':'Internal banking posting acknowledgement',
  reference:'CFH-POST-'+String(row._id).toUpperCase(),
  branch:branch?.name||'Recorded operating branch',timeZone:zone,
  recordedAt:businessTime.format(row.reviewedAt||row.updatedAt||row.createdAt,zone),
  partyLabel,customer:party,status:'Posted to internal financial books',lines,reversed:false,
  warning:row.action==='transfer_collect'?
   'Collection was posted internally. The receiver payout is still outstanding. This is not a paid-out receipt or proof of provider settlement.':
   'This confirms a posted manual financial record and its audited evidence. It is not proof of external bank, network, or provider settlement.',
  returnUrl:'/tenant/funded/'+String(row._id)
 };
}
module.exports={fromDetail};