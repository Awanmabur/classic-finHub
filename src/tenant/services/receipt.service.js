'use strict';
// A read-only acknowledgement of an internal Mobile Money record. It is neither
// an invoice nor evidence of network payment. Access control belongs to the
// scoped record lookup in the tenant route.
const mobile=require('./mobileMoney.service');
const {currencyCodes}=require('../../config/currencies');
function acknowledgement(record){
 if(!record||!record._id||!['cash_in','cash_out'].includes(record.operation)||!currencyCodes.includes(record.currency)){
   const error=new Error('Invalid operational acknowledgement source');error.status=400;throw error;
 }
 const cashCurrency=record.settlementCurrency||record.currency;
 if(!currencyCodes.includes(cashCurrency)){
  const error=new Error('Invalid physical settlement currency');error.status=409;throw error;
 }
 return {record,reference:`CFH-ACK-${String(record._id).toUpperCase()}`,
   amount:mobile.formatMoneyMinor(record.amountMinor,record.currency),
   cashSettlement:mobile.formatMoneyMinor(record.settlementAmountMinor??record.amountMinor,cashCurrency),
   fee:mobile.formatMoneyMinor(record.feeMinor,record.currency),
   exchangeRate:record.crossCurrency&&record.forexRateDecimal?
    `${record.forexSide==='buy'?'Buy':'Sell'}: 1 ${record.currency} = ${record.forexRateDecimal} ${cashCurrency}`:null};
}
module.exports={acknowledgement};
