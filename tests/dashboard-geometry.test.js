'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ejs=require('ejs');

const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('approved tenant and platform styles keep the palette and use rectangular rounded textareas',()=>{
 const tenant=read('public/css/approved-tenant.css');
 const platform=read('public/css/dashboard.css');
 for(const css of [tenant,platform]){
   assert.match(css,/textarea,textarea\.control,\.field textarea,\.tenantCleanField textarea\{border-radius:14px!important/);
   assert.match(css,/\.sideFoot \.accountActions\{padding:10px 0 0;flex-wrap:wrap/);
   assert.match(css,/\.tenantAuditNote\{margin:0/);
   assert.match(css,/\.signoutProgress\{position:fixed;inset:0/);
 }
 assert.match(tenant,/\/\* END APPROVED INDEX\.HTML CASCADE \*\//);
 const shared=read('public/css/dashboard-layout.css');
 assert.match(shared,/#workspaceContent form\.appointmentFilters\{display:grid/);
 assert.match(shared,/#workspaceContent \.appointmentTable\{min-width:940px/);
 assert.match(shared,/#workspaceContent \.platformTenantsPage/);
});

test('tenant audit note stays inside padded card body',async()=>{
 const html=await ejs.renderFile(path.join(root,'src/views/tenant/audit/index.ejs'),{data:{logs:[]}});
 assert.match(html,/<div class="cardBody"><p class="tiny tenantAuditNote">/);
 assert.match(html,/Database access must be restricted/);
});

test('platform appointments retain working decision controls and row layout',async()=>{
 const item={
   _id:'507f1f77bcf86cd799439011',businessName:'Example',status:'pending',
   contactName:'Contact',email:'contact@example.test',phone:'',preferredDate:null,
   modules:['mobile_money'],scheduledAt:null,meetingLink:'',notes:'',reviewNote:'',
   revision:0
 };
 const html=await ejs.renderFile(path.join(root,'src/views/platform/appointments/index.ejs'),{
   data:{appointments:[item],filters:{status:'',q:''},moduleLabels:{mobile_money:'Mobile Money'},nextCursor:null},
   csrfToken:'test-csrf'
 });
 assert.match(html,/class="denseDirectory appointmentTable"/);
 assert.match(html,/data-appointment-toggle/);
 assert.match(html,/class="appointmentDetailRow"/);
 assert.match(html,/class="appointmentDecision appointmentRowDecision"/);
 assert.match(html,/name="_csrf" value="test-csrf"/);
 assert.match(html,/name="action" value="confirm"/);
 assert.match(html,/name="action" value="cancel"/);
});

test('logout remains CSRF-protected POST and centered progress only affects presentation',()=>{
 const sidebar=read('src/views/partials/dashboard-sidebar.ejs');
 const script=read('public/js/dashboard.js');
 assert.equal((sidebar.match(/method="post" action="\/logout"/g)||[]).length,2);
 assert.match(sidebar,/name="_csrf" value="<%= csrfToken %>"/);
 assert.match(script,/form\[action="\/logout"\]/);
 assert.match(script,/indicator\.hidden=false/);
});

test('platform audit note is padded, platform account is collapsible and auth cards are spaced',()=>{
 const audit=read('src/views/platform/audit/index.ejs');
 const sidebar=read('src/views/partials/dashboard-sidebar.ejs');
 const script=read('public/js/dashboard.js');
 const auth=read('public/css/style.css');
 assert.match(audit,/<div class="cardBody"><p class="tiny">Audit records use/);
 assert.match(sidebar,/class="sidebarAccount platformAccount"/);
 assert.match(script,/\[data-appointment-toggle\]/);
 assert.match(auth,/\.auth-body \.auth-main \.auth-shell\{display:grid;column-gap:/);
});
