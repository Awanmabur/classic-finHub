'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const ejs=require('ejs');

const formPath=path.join(__dirname,'../src/views/tenant/mobile-money/_entry-form.ejs');
const wallet={id:'507f1f77bcf86cd799439012',name:'MTN Uganda float',
 currency:'UGX',network:'MTN',expectedMinor:'1000000',state:'active',
 reconciliation:'matched',assignedToOperator:true,isDefault:true,feeTreatment:'record_only'};
const cash={id:'507f1f77bcf86cd799439013',name:'SSP cash drawer',
 kind:'cash',currency:'SSP',expectedMinor:'50000000',state:'active',
 reconciliation:'matched',assignedToOperator:true,postingReady:true,isDefault:true};
const locals=operation=>({
 operation,csrfToken:'test-csrf',
 user:{permissions:['*']},
 currentBranch:{_id:'507f1f77bcf86cd799439014',currency:'SSP',currencies:['SSP','UGX']},
 data:{funds:{wallets:[wallet],paymentAccounts:[cash]},
  idempotencyKey:'00000000-0000-4000-8000-000000000001',
  entryCurrencies:[{code:'SSP',label:'SSP'},{code:'UGX',label:'UGX'}],
  entryCurrency:'UGX',networksAvailable:['MTN']},
 currencyLabel:code=>code
});

test('Deposit renders cash drawer first and cash amount in drawer currency',async()=>{
 const html=await ejs.renderFile(formPath,locals('cash_in'));
 const drawer=html.indexOf('data-payment-account-field'),walletField=html.indexOf('data-wallet-account-field');
 assert(drawer!==-1&&walletField!==-1&&drawer<walletField,
  'deposit source cash drawer must precede destination float wallet in DOM and keyboard order');
 assert.match(html,/Customer cash received<\/span> \(<span data-mobile-currency-label>SSP<\/span>\)/);
 assert.match(html,/name="fxProviderAmountMinor"/);
 assert.match(html,/Cash drawer → provider float wallet/);
 assert.doesNotMatch(html,/name="cashCurrency"/,'cash currency must come from selected drawer');
});
test('Withdrawal continues to render float wallet first and its native amount',async()=>{
 const html=await ejs.renderFile(formPath,locals('cash_out'));
 const drawer=html.indexOf('data-payment-account-field'),walletField=html.indexOf('data-wallet-account-field');
 assert(drawer!==-1&&walletField!==-1&&walletField<drawer);
 assert.match(html,/Wallet withdrawal amount<\/span> \(<span data-mobile-currency-label>UGX<\/span>\)/);
 assert.match(html,/Provider float wallet → cash drawer/);
});
