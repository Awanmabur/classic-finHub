'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {classify}=require('../src/tenant/services/mobileMoneyRisk.service');
test('risk signals avoid spurious high-amount alerts with insufficient comparable history',()=>{
 assert.deepEqual(classify({amountMinor:'200000',peerAmounts:['1000']}),[]);
});
test('rapid repeat, outlier and wallet variance are advisory independently',()=>{
 assert.deepEqual(classify({amountMinor:'5500',peerAmounts:Array(10).fill('1000'),previousForPhone:3,walletExpected:'5000',walletReported:'4500'}),
 ['rapid_repeat','unusual_amount','wallet_balance_mismatch']);
});
test('risk comparisons preserve integer precision for large amounts',()=>{
 assert.deepEqual(classify({amountMinor:'50000000000000000000',peerAmounts:Array(12).fill('1000000000000000000')}),['unusual_amount']);
});
