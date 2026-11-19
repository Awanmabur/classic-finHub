'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),ejs=require('ejs'),path=require('node:path');
const reports=require('../src/tenant/services/approvedReports.service');
test('approved report keeps date filters and presents real cash movement evidence separately from request groups',async()=>{
 const report={key:'banking',page:reports.pages.banking,filters:{from:'2026-11-05',to:'2026-11-06'},scope:{},sourceAvailable:true,cash:null,income:[],impact:{UGX:'107'},expenses:null,
  format:require('../src/tenant/services/forex.service').amountLabel,note:'Internal books',rows:[{module:'Banking',activity:'deposit request',status:'posted_manual',currency:'UGX',count:1,volume:'UGX 10,000',fees:'UGX 0'}],
  postedCash:[{sourceType:'banking',module:'Banking',currency:'UGX',count:2,cashInMinor:'10100',cashOutMinor:'1000',netMinor:'9100'}]};
 const html=await ejs.renderFile(path.resolve(__dirname,'../src/views/tenant/reports/approved.ejs'),{data:{report,canCreateExpense:false,canExport:true},user:{name:'Analyst'}});
 assert.match(html,/name="from" value="2026-11-05"/);assert.match(html,/name="to" value="2026-11-06"/);assert.match(html,/Apply filters/);assert.match(html,/export.csv\?from=2026-11-05&amp;to=2026-11-06/);
 assert.match(html,/UGX 9,100/);assert.match(html,/posted cash fees and reversals/);assert.match(html,/Legacy mobile money cash records/);assert.match(html,/See cash movement totals/);
 assert.doesNotMatch(html,/No posted cash effect|Recorded fees, Wallet Balance and Bank payments are excluded/);
 const csv=reports.csv(report);assert.match(csv,/Net cash movement minor units/);assert.match(csv,/"9100"/);assert.match(csv,/"107"/);
});

test('daily report CSV includes posted fee income independently of principal and preserves currencies',()=>{
 const report={key:'daily',timeZone:'Africa/Juba',income:[],impact:{},postedCash:[],rows:[],
  realizedIncome:[
   {module:'Money Transfer',currency:'SSP',count:2,amount:'SSP 20.00',amountMinor:'2000'},
   {module:'Mobile Money',currency:'UGX',count:1,amount:'UGX 150',amountMinor:'150'},
   {module:'Banking',currency:'KES',count:3,amount:'KES 42.00',amountMinor:'4200'}
  ]};
 const csv=reports.csv(report);
 assert.match(csv,/"Money Transfer","Verified posted fee income","posted","SSP","2"/);
 assert.match(csv,/"Mobile Money","Verified posted fee income","posted","UGX","1"/);
 assert.match(csv,/"Banking","Verified posted fee income","posted","KES","3"/);
 assert.match(csv,/"150"/);
 assert.match(csv,/"2000"/);
 assert.match(csv,/"4200"/);
 assert.doesNotMatch(csv,/Total profit/);
});
