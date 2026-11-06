'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const capture=require('../src/tenant/services/operationCapture.service');
const mobile=require('../src/tenant/services/mobileMoney.service');
const {randomUUID}=require('node:crypto');
test('approved operation capture fields validate choices, lengths, phones and exact proposed fees',()=>{
 const transfer=capture.parse('money_transfer',{senderDocument:'DOC-1',receiverDocument:'DOC-2',transferMethod:'Mobile Money',purpose:'Family support',exchangeRate:'3700.5000'});
 assert.equal(transfer.exchangeRate,'3700.5');assert.equal(transfer.senderDocument,'DOC-1');
 const bank=capture.parse('banking',{paymentChannel:'Bank settlement',customerPhone:'+256700123456',externalReference:'SLIP-123'});
 assert.equal(bank.customerPhone,'+256700123456');
 const fx=capture.parse('forex',{commission:'1.2300',settlementMethod:'Wallet balance',customerPhone:'+256700123456',identityDocument:'PASSPORT-1',rateSource:'Independent board'});
 assert.equal(fx.commission,'1.23');assert.equal(capture.commissionMinor(fx,'USD'),123n);assert.throws(()=>capture.commissionMinor(fx,'UGX'));
 for(const bad of [{paymentChannel:'Card'},{customerPhone:'invalid'},{externalReference:'<script>'},{externalReference:['bad']}])assert.throws(()=>capture.parse('banking',bad));
 assert.throws(()=>capture.parse('money_transfer',{exchangeRate:'1e3'}));assert.throws(()=>capture.parse('forex',{commission:'-1'}));
});
test('operation idempotency includes every new field and keeps legacy default equivalence',()=>{
 for(const key of ['money_transfer','banking','forex'])assert(capture.equivalent(key,undefined,capture.parse(key,{})));
 const value=capture.parse('banking',{externalReference:'REF-ONE'});
 assert(capture.equivalent('banking',value,{...value}));assert(!capture.equivalent('banking',value,{...value,externalReference:'REF-TWO'}));
});
test('manual customer name is optional when the supplied phone identifies the record',()=>{
 const data={customerPhone:'+256 700-123456',network:'MTN',networkReference:'MOBILE-123',currency:'UGX',amount:'1000',fee:'0',idempotencyKey:randomUUID()};
 const value=mobile.validate(data,'cash_in');assert.equal(value.customer,'+256700123456');assert.equal(value.customerPhone,'+256700123456');
 assert.throws(()=>mobile.validate({...data,customerPhone:''},'cash_in'));assert.throws(()=>mobile.toMinor(['1'],'USD'));
});
