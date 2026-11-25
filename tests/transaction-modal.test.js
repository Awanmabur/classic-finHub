'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const ejs=require('ejs');
const path=require('node:path');
const {permissionsFor}=require('../src/config/roles');
const template=path.resolve(__dirname,'../src/views/layouts/dashboard.ejs');
const links=[['/tenant/dashboard','Overview'],['/tenant/mobile-money','Mobile Money'],['/tenant/mobile-money/network-activity','Network activity'],['/tenant/money-transfer','Money Transfer'],['/tenant/banking','Banking'],['/tenant/forex','Forex'],['/tenant/approvals','Approvals']];
const fixture=(permissions,paths=links.map(entry=>entry[0]))=>({
  context:'tenant',currentPath:'/tenant/dashboard',pageTitle:'Overview',pageSub:'Activity',
  tenant:{name:'Test workspace',slug:'test-workspace',status:'active',plan:'agent',subscription:{status:'granted'}},
  user:{name:'Operator',role:permissions.includes('*')?'Tenant Owner':'Mobile Money Operator',permissions},
  menu:[{label:'Workspace',items:links.filter(([href])=>paths.includes(href)).map(([href,label])=>({href,label,icon:'fa-gauge-high'}))}],
  csrfToken:'test-csrf',assetVersion:'test',flash:null,money:()=>'',amountFromMinor:()=>'',
  view:'../tenant/dashboard/index',data:{summary:{total:0,recent:[],summaries:[]},hasMobileMoney:paths.includes('/tenant/mobile-money'),moduleGrants:[]},
  operationBranch:{name:'Kampala Main',currency:'UGX'}
});

test('transaction launcher uses an accessible real-form dialog and a fixed branch label',async()=>{
  const html=await ejs.renderFile(template,fixture(['*']));
  assert.match(html,/<dialog id="transactionDialog"[^>]+aria-labelledby="transactionTitle"/);
  assert.match(html,/id="newTransactionBtn"[^>]+data-open-transaction/);
  assert.match(html,/Kampala Main/);
  assert.match(html,/data-branch-name="Kampala Main" data-branch-currency="UGX"/);
  assert.match(html,/data-transaction-kind="cash_in"/);
  assert.match(html,/data-transaction-kind="cash_out"/);
  assert.match(html,/id="newTransactionBtn" href="\/tenant\/transactions\/new"/,'the launcher retains a working page fallback');
  assert.doesNotMatch(html,/<select[^>]+(?:name="branchId"|id="branchSelect")/);
  assert.match(html,/data-transaction-status role="status" aria-live="polite"/);
});

test('transaction choices require both module visibility and the exact operation permission',async()=>{
  const html=await ejs.renderFile(template,fixture(['dashboard.view','mobile_money.cash_in'],['/tenant/dashboard','/tenant/mobile-money']));
  assert.match(html,/data-transaction-kind="cash_in"/);
  assert.doesNotMatch(html,/data-transaction-kind="cash_out"/);
  assert.doesNotMatch(html,/data-transaction-kind="(?:transfer|banking|forex|approval)"/);
  const hidden=await ejs.renderFile(template,fixture(['dashboard.view','mobile_money.cash_in'],['/tenant/dashboard']));
  assert.doesNotMatch(hidden,/id="transactionDialog"/,'a role permission alone must not expose an unassigned module');
});

test('read-only accounts do not receive write dialogs or a dead New transaction button',async()=>{
  const html=await ejs.renderFile(template,fixture(['dashboard.view','mobile_money.view'],['/tenant/dashboard','/tenant/mobile-money','/tenant/mobile-money/network-activity']));
  assert.doesNotMatch(html,/id="transactionDialog"/);
  assert.doesNotMatch(html,/id="newTransactionBtn"/);
  assert.match(html,/href="\/tenant\/mobile-money\/network-activity"/);
});

test('the dashboard launcher offers configured entries and shows a receipt only after one exists',async()=>{
 const options=fixture(['*']);
 options.menu[0].items.push({href:'/tenant/last-receipt',label:'Last receipt'});
 options.data.dashboardTransactionModules=[];
 const empty=await ejs.renderFile(template,options);
 assert.doesNotMatch(empty,/id="newTransactionBtn"|id="lastReceiptBtn"|id="search"/);
 options.data.dashboardTransactionModules=['mobile_money'];
 options.data.workspaceSnapshot={latestAcknowledgement:{href:'/tenant/mobile-money/123/acknowledgement'}};
 const configured=await ejs.renderFile(template,options);
 assert.match(configured,/data-transaction-kind="cash_in"/);
 assert.doesNotMatch(configured,/data-transaction-kind="(?:transfer|banking_deposit|forex_buy)"/);
 assert.match(configured,/id="lastReceiptBtn" href="\/tenant\/mobile-money\/123\/acknowledgement"/);
});

test('overview shows recent receipts and links to the separate Cash Day',async()=>{
  const options=fixture(['*']);
  options.menu[0].items.push({href:'/tenant/cash/shifts',label:'Cash day'},{href:'/tenant/last-receipt',label:'Last receipt'});
  options.data.workspaceSnapshot={
    cash:[{currency:'UGX',expectedFormatted:'UGX 510,000',shiftCount:1}],cashDay:{status:'open',currency:'UGX',branchName:'Kampala Main'},
    latestAcknowledgement:{href:'/tenant/mobile-money/123/acknowledgement',label:'Last acknowledgement'},
    recentActivity:[{kind:'mobile_money',label:'Mobile money cash in',subtitle:'MTN · VERIFIED-REFERENCE',amountLabel:'UGX 10,000',href:'/tenant/mobile-money/123/acknowledgement',createdAt:new Date()}]
  };
  const html=await ejs.renderFile(template,options);
  assert.match(html,/Cash day/);
  assert.doesNotMatch(html,/Kampala Main · UGX|>Open day<|>Close day</);
  assert.doesNotMatch(html,/UGX 510,000|1 open shift/);
  assert.match(html,/MTN · VERIFIED-REFERENCE/);
  assert.match(html,/href="\/tenant\/mobile-money\/123\/acknowledgement"/);
  assert.match(html,/Last receipt/);
  assert.doesNotMatch(html,/6,500,000|Load demo|id="branchSelect"/);
});

test('Cash Day stays available in navigation and outside the transaction launcher',async()=>{
  const options=fixture(['*']);
  options.menu[0].items.push({href:'/tenant/cash/shifts',label:'Cash day',icon:'fa-cash-register'});
  const html=await ejs.renderFile(template,options);
  assert.match(html,/href="\/tenant\/cash\/shifts"[^>]*>Cash day/);
  assert.doesNotMatch(html,/>Open day<|>Close day<|data-transaction-kind="cash_shift_(open|close)"/);
});
