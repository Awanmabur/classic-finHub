'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {TABLES,quote}=require('../src/tenant/pricing/customerNetworkFees');
test('official customer network fee references are never agent earnings or accounting entries',()=>{
 assert.equal(TABLES.length,2);
 const mtn=TABLES.find(row=>row.network==='MTN');
 assert.equal(mtn.currency,'UGX');
 assert.equal(mtn.status,'published_reference');
 assert.match(mtn.source,/mtn\.co\.ug/);
 assert.equal(quote('MTN','cash_in','500').customerFeeMinor,'0');
 assert.equal(quote('MTN','cash_out','500').customerFeeMinor,'330');
 assert.equal(quote('MTN','send','500').customerFeeMinor,'100');
 assert.equal(quote('MTN','send_bank','500').status,'no_rate');
 assert.equal(quote('MTN','send_bank','2501').customerFeeMinor,'1500');
 assert.equal(quote('MTN','bill_payment','15001').customerFeeMinor,'650');
 assert.equal(quote('MTN','cash_out','5000001').status,'no_rate');
 assert.equal(quote('MTN','cash_out','500').postsToLedger,false);
});
test('Airtel public schedule is explicitly historical; South Sudan unknown values remain unknown',()=>{
 const airtel=TABLES.find(row=>row.network==='Airtel');
 assert.equal(airtel.status,'historical_source_unverified');
 assert.equal(quote('Airtel','cash_out','2500').customerFeeMinor,'330');
 assert.equal(quote('Airtel','send','2501').customerFeeMinor,'100');
 assert.equal(quote('MTN SSD','cash_out','100000').status,'provider_tariff_unknown');
 assert.throws(()=>quote('MTN','cash_out','-1'));
 assert.throws(()=>quote('MTN','cash_out','1.5'));
});
