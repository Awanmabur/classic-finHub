'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {formatMoneyMinor}=require('../src/tenant/services/mobileMoney.service');

test('money formatting preserves signed minor units, including sub-unit shortages and large totals',()=>{
  for(const [value,currency,expected] of [
    ['-5','KES','KES -0.05'],['-1005','KES','KES -10.05'],
    ['-1000','UGX','UGX -1,000'],['0','KES','KES 0.00'],
    ['5','KES','KES 0.05'],['12345678901234567','KES','KES 123,456,789,012,345.67'],
    ['-12345678901234567','KES','KES -123,456,789,012,345.67']
  ]) assert.equal(formatMoneyMinor(value,currency),expected);
});
