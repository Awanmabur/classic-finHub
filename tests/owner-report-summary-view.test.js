'use strict';

const assert=require('node:assert/strict');
const test=require('node:test');
const path=require('node:path');
const ejs=require('ejs');
const {formatMoneyMinor}=require('../src/tenant/services/mobileMoney.service');
const {currencyLabel}=require('../src/config/currencies');

const template=path.resolve(__dirname,'../src/views/tenant/reports/summary.ejs');
function report(overrides={}){
 return {
  period:'custom',from:'2026-11-01',to:'2026-11-24',today:'2026-11-24',
  timeZone:'Africa/Kampala',branchName:'Serviced branches',allBranches:true,
  totalCount:3,byCurrency:[
   {currency:'UGX',count:2,amountMinor:'100000',incomeMinor:'1200',expenseMinor:'500',netMinor:'700'},
   {currency:'USD',count:2,amountMinor:'12345',incomeMinor:'300',expenseMinor:'400',netMinor:'-100'}
  ],byModule:[
   {moduleKey:'mobile_money',moduleLabel:'Mobile Money',currency:'UGX',count:2,amountMinor:'100000',
    incomeMinor:'1200',expenseMinor:'500',netMinor:'700'},
   {moduleKey:'forex',moduleLabel:'Forex',currency:'USD',count:1,amountMinor:'2345',
    incomeMinor:null,expenseMinor:null,netMinor:null}
  ],...overrides
 };
}

test('owner summary shows a single transaction count and separate exact currency values',async()=>{
 const html=await ejs.renderFile(template,{
  data:{report:report(),canExport:true,formatMoney:formatMoneyMinor,currencyLabel}
 });
 assert.match(html,/>3<\/strong> recorded transactions/);
 assert.match(html,/All modules[\s\S]*By module and currency/);
 for(const value of ['UGX 100,000','UGX 700','USD 123.45','USD -1.00','USD 23.45'])assert(html.includes(value),value);
 assert.match(html,/Forex[\s\S]*USD 23\.45[\s\S]*—/);
 assert.match(html,/Africa\/Kampala/);
 assert.match(html,/period=custom&amp;from=2026-11-01&amp;to=2026-11-24/);
 for(const period of ['day','week','month'])assert(html.includes('?period='+period));
});

test('an invalid reporting period preserves usable filters and renders an error',async()=>{
 const html=await ejs.renderFile(template,{
  data:{report:report({from:'invalid',totalCount:null}),formError:'Enter valid start and end dates'}
 });
 assert.match(html,/role="alert">Enter valid start and end dates/);
 assert.match(html,/name="period" value="custom"/);
 assert.doesNotMatch(html,/recorded transactions|Export CSV/);
});
