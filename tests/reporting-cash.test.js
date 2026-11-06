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
