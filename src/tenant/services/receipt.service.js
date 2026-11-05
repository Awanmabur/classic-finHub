'use strict';
// A read-only acknowledgement of an internal Mobile Money record. It is neither
// an invoice nor evidence of network payment. Access control belongs to the
// scoped record lookup in the tenant route.
const mobile=require('./mobileMoney.service');
function acknowledgement(record){
 if(!record||!record._id||!['cash_in','cash_out'].includes(record.operation)||!['UGX','KES'].includes(record.currency)){
   const error=new Error('Invalid operational acknowledgement source');error.status=400;throw error;
 }
 return {record,reference:`CFH-ACK-${String(record._id).toUpperCase()}`,
   amount:mobile.formatMoneyMinor(record.amountMinor,record.currency),
   fee:mobile.formatMoneyMinor(record.feeMinor,record.currency)};
}
module.exports={acknowledgement};
