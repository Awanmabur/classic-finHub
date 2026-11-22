'use strict';
// Only NEW, committed and funded receipts may request the print sheet.
const oid=x=>/^[a-f0-9]{24}$/i.test(String(x||''));
function mobile(result){
 const v=result?.created||result?.mobile;
 return !result?.duplicate&&v?.status==='recorded'&&v.fundingState==='book_recorded'&&oid(v._id)&&
 Array.isArray(v.fundJournalIds)&&v.fundJournalIds.length?
 '/tenant/mobile-money/'+v._id+'/acknowledgement?autoPrint=1':null;
}
function loan(result){
 const v=result?.payment;
 return !result?.duplicate&&oid(v?._id)&&oid(v?.loanId)&&v?.batchId?
 '/tenant/loans/'+v.loanId+'/repayments/'+v._id+'/receipt?autoPrint=1':null;
}
function airtime(result){
 const v=result?.record;
 return !result?.duplicate&&oid(v?._id)&&v?.type==='sale'&&v.batchId?
 '/tenant/airtime/'+v._id+'/receipt?autoPrint=1':null;
}
function funded(result){
 const v=result?.execution;
 return !result?.duplicate&&oid(v?._id)&&v?.status==='posted_manual'&&
 Array.isArray(v.journalIds)&&v.journalIds.length?
 '/tenant/funded/'+v._id+'/receipt?autoPrint=1':null;
}
module.exports={mobile,loan,airtime,funded};