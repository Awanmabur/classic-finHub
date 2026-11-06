'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const ejs=require('ejs');
const path=require('node:path');
const template=path.resolve(__dirname,'../src/views/layouts/dashboard.ejs');
const links=[['/tenant/dashboard','Overview'],['/tenant/mobile-money','Mobile Money'],['/tenant/money-transfer','Money Transfer'],['/tenant/banking','Banking'],['/tenant/forex','Forex'],['/tenant/approvals','Approvals']];
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
  assert.match(html,/href="\/tenant\/money-transfer\/send" data-transaction-kind="transfer"/,'quick actions retain a working page fallback');
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
  const html=await ejs.renderFile(template,fixture(['dashboard.view','mobile_money.view'],['/tenant/dashboard','/tenant/mobile-money']));
  assert.doesNotMatch(html,/id="transactionDialog"/);
  assert.doesNotMatch(html,/id="newTransactionBtn"/);
  assert.match(html,/href="\/tenant\/mobile-money\/history"/);
});

test('overview displays supplied database cash and acknowledgements without prototype balances',async()=>{
  const options=fixture(['*']);
  options.data.workspaceSnapshot={
    cash:[{currency:'UGX',expectedFormatted:'UGX 510,000',shiftCount:1}],cashBranchName:'Kampala Main',
    latestAcknowledgement:{href:'/tenant/mobile-money/123/acknowledgement',label:'Last acknowledgement'},
    recentActivity:[{kind:'mobile_money',label:'Mobile money cash in',subtitle:'MTN · VERIFIED-REFERENCE',amountLabel:'UGX 10,000',href:'/tenant/mobile-money/123/acknowledgement',createdAt:new Date()}]
  };
  const html=await ejs.renderFile(template,options);
  assert.match(html,/Provisional physical cash/);
  assert.match(html,/UGX 510,000/);
  assert.match(html,/1 open shift/);
  assert.match(html,/MTN · VERIFIED-REFERENCE/);
  assert.match(html,/href="\/tenant\/mobile-money\/123\/acknowledgement"/);
  assert.match(html,/Last receipt/);
  assert.doesNotMatch(html,/6,500,000|Load demo|id="branchSelect"/);
});

test('cash shift actions use the existing opener roles and actual current shift',async()=>{
  const options=fixture(['*']);
  options.menu[0].items.push({href:'/tenant/mobile-money/shifts',label:'Cash shifts',icon:'fa-cash-register'});
  const opening=await ejs.renderFile(template,options);
  assert.match(opening,/href="\/tenant\/mobile-money\/shifts" data-transaction-kind="cash_shift_open">Open day/);
  options.data.workspaceSnapshot={cash:[],recentActivity:[],currentCashShift:{id:'real-shift',status:'open',href:'/tenant/mobile-money/shifts/real-shift'}};
  const closing=await ejs.renderFile(template,options);
  assert.match(closing,/href="\/tenant\/mobile-money\/shifts\/real-shift">Close day/);
  assert.doesNotMatch(closing,/href="\/tenant\/mobile-money\/shifts" data-transaction-kind="cash_shift_open">Open day/);
  options.user.role='Branch Manager';
  const supervisor=await ejs.renderFile(template,options);
  assert.doesNotMatch(supervisor,/data-transaction-kind="cash_shift_open"/,'supervisors review shifts; they do not open an operator shift');
});
