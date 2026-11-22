'use strict';
// Read-only branded receipts from immutable, branch-scoped tenant records.
// These documents never assert external telecom/bank settlement.
const F=require('./security');
const loans=require('./loans.service');
const {models:loanModels}=require('./loans.models');
const {models:airtimeModels}=require('./airtime.models');
const {branchModel}=require('../models');
const businessTime=require('../../utils/businessTime');
const money=require('../services/mobileMoney.service').formatMoneyMinor;
async function location(conn,id){
 const branch=await branchModel(conn).findOne({_id:id}).select('name timeZone currency').lean();
 return {name:branch?.name||'Recorded operating branch',zone:businessTime.forBranch(branch)};
}
async function loanPayment(conn,tenant,actor,loanId,paymentId){
 const {loan,customer}=await loans.detail(conn,tenant,actor,loanId);
 const id=F.oid(paymentId,'payment');
 const {payment,correction}=loanModels(conn);
 const found=await payment.findOne({_id:id,loanId:loan._id,tenantId:tenant._id,branchId:loan.branchId}).lean();
 if(!found)throw F.fail('Repayment receipt not found',404);
 const reversed=Boolean(await correction.exists({paymentId:found._id,tenantId:tenant._id,loanId:loan._id}));
 const branch=await location(conn,loan.branchId);
 return {documentType:'Loan repayment receipt',reference:found.reference,
  recordedAt:businessTime.format(found.createdAt,branch.zone),timeZone:branch.zone,
  branch:branch.name,customer:customer?.name||'Recorded borrower',
  status:reversed?'Reversed in internal books':'Recorded in internal funds books',
  reversed,currency:found.currency,
  lines:[['Amount received',money(found.amountMinor,found.currency)],
   ['Principal allocated',money(found.principalMinor,found.currency)],
   ['Interest allocated',money(found.interestMinor,found.currency)]],
  warning:'Repayment amounts and original evidence are taken from the immutable loan transaction. Corrections remain visible. External bank or mobile network settlement is not verified by this document.',
  returnUrl:'/tenant/loans/'+encodeURIComponent(String(loan._id))};
}
async function airtimeSale(conn,tenant,actor,recordId){
 const current=await F.access(conn,tenant,actor,'airtime','airtime.view');
 const id=F.oid(recordId,'airtime sale');
 const {record,correction}=airtimeModels(conn);
 const found=await record.findOne({_id:id,tenantId:current.tenant._id,type:'sale',...F.scope(current.actor)}).lean();
 if(!found)throw F.fail('Airtime sale receipt not found',404);
 const reversed=Boolean(await correction.exists({tenantId:current.tenant._id,recordId:found._id}));
 const branch=await location(conn,found.branchId);
 return {documentType:'Airtime sale acknowledgement',reference:found.reference,
  recordedAt:businessTime.format(found.createdAt,branch.zone),timeZone:branch.zone,
  branch:branch.name,customer:found.phone||'Recipient not recorded',
  status:reversed?'Reversed in internal books':'Operator-confirmed delivery recorded internally',
  reversed,currency:found.currency,
  lines:[['Airtime network',found.network],
   ['Airtime value',money(found.denominationMinor,found.currency)],
   ['Sale amount',money(found.retailMinor,found.currency)],
   ['Operator-entered provider reference (unverified)',found.reference]],
  warning:'This is an internal record of an operator-confirmed airtime sale, not proof of a successful telecom top-up or provider settlement. Confirm delivery with the network.',
  returnUrl:'/tenant/airtime'};
}
module.exports={loanPayment,airtimeSale};
