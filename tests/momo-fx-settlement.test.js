'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const settlement=require('../src/tenant/services/momoFxSettlement.service');
const models=require('../src/tenant/schemas/MomoFxSettlement');

test('cross-currency posting is disabled by default independent of caller inputs',async()=>{
 const before=process.env.CLASSICFIN_MOMO_FX_POSTING_ENABLED;
 try{
  delete process.env.CLASSICFIN_MOMO_FX_POSTING_ENABLED;
  await assert.rejects(settlement.settleVerified(null,null,null,null,null),
   error=>error.status===503&&/disabled/.test(error.message));
 }finally{
  if(before===undefined)delete process.env.CLASSICFIN_MOMO_FX_POSTING_ENABLED;
  else process.env.CLASSICFIN_MOMO_FX_POSTING_ENABLED=before;
 }
});
test('cross-currency records require linked journal and verified provider evidence',()=>{
 for(const key of ['journalBatchId','providerEvidenceId','rateId','walletAccountId','cashAccountId'])
  assert.equal(models.recordSchema.path(key).isRequired,true,key+' is required');
});
test('internal Mobile Money book records do not require compliance document grants',()=>{
 assert.equal(models.recordSchema.path('complianceGrantId').isRequired,false);
 const rate=require('../src/tenant/services/mobileMoneyFxRate.service');
 assert.equal(rate.inputRate({fromCurrency:'UGX',toCurrency:'SSP',side:'buy',
  rateBaseUnits:'1000',quotedRate:'350',validHours:'24'}).rateDecimal,'0.35');
 assert.equal(rate.inputRate({fromCurrency:'KES',toCurrency:'SSP',side:'sell',
  rateBaseUnits:'1000',quotedRate:'2500'}).rateDecimal,'2.5');
 assert.throws(()=>rate.inputRate({fromCurrency:'UGX',toCurrency:'UGX',
  side:'buy',rateBaseUnits:'1000',quotedRate:'350'}),{status:400});
 assert.throws(()=>rate.inputRate({fromCurrency:'UGX',toCurrency:'SSP',
  side:'buy',rateBaseUnits:'10',quotedRate:'350'}),{status:400});
});

test('idempotency, provider reference and external evidence have unique indexes',()=>{
 const indexes=models.recordSchema.indexes().filter(([keys,options])=>options.unique);
 for(const field of ['idempotencyKey','providerReference','providerEvidenceId'])
  assert(indexes.some(([keys])=>Object.hasOwn(keys,field)),field+' has unique index');
});
test('all cross-currency financial records are append-only',()=>{
 const middleware=models.recordSchema.s.hooks;
 for(const op of ['updateOne','updateMany','findOneAndUpdate','deleteOne','deleteMany'])
  assert(middleware._pres.get(op)?.length,op+' must reject direct mutation');
});

test('cross-currency grant uses pending independent document verification before activation',()=>{
 const grant=models.grantSchema;
 assert(grant.path('status').enumValues.includes('pending_review'));
 assert.equal(grant.path('requestedBy').options.immutable,true);
 assert.equal(grant.path('providerAuthorizationReference').isRequired,true);
 assert.equal(grant.path('regulatoryAuthorizationReference').isRequired,true);
 const auth=require('../src/tenant/services/momoFxAuthorization.service');
 assert.equal(auth.ref('LICENSE-VALID-1234','licence'),'LICENSE-VALID-1234');
 assert.throws(()=>auth.ref('fake','licence'),{status:400});
 assert.throws(()=>auth.expires('2020-01-01'),{status:400});
});
