'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { permissionsFor } = require('../src/config/roles');
const { tenantMenu } = require('../src/services/menu.service');
const { fromMinor } = require('../src/tenant/services/mobileMoney.service');
const base = path.join(__dirname,'../src/views/layouts/dashboard.ejs');
const record={_id:'507f1f77bcf86cd799439011',operatorId:'507f1f77bcf86cd799439012',network:'MTN',
  networkReference:'MTN-TEST1',customer:'John Doe',currency:'UGX',amountMinor:'1500',feeMinor:'25',status:'pending_verification',
  operation:'cash_in',reviewState:'awaiting_review',createdAt:new Date('2026-11-03T12:00:00Z')};
const tenant={slug:'test-tenant',name:'Testing',plan:'agent',status:'active',enabledModules:['mobile_money']};
const summary={total:1,pending:1,awaitingReview:1,recent:[record],summaries:[{
  _id:{currency:'UGX',operation:'cash_in',network:'MTN',status:'pending_verification',reviewState:'awaiting_review'},
  count:1,volumeFormatted:'UGX 1,500',feesFormatted:'UGX 25'}]};
async function page(role, view, data) {
  const user={id:'507f1f77bcf86cd799439013',role,name:'Staff',email:'staff@tenant.test',permissions:permissionsFor(role),branchId:'aaaaaaaaaaaaaaaaaaaaaaaa'};
  return ejs.renderFile(base,{
    context:'tenant',pageTitle:'Test',pageSub:'Test details',currentPath:`/tenant/${view}`,
    tenant,user,menu:tenantMenu(tenant,user),view:`../tenant/${view}/index`,data,flash:null,
    assetVersion:'test',csrfToken:'abc123',money:(currency,amount)=>`${currency} ${amount}`,amountFromMinor:fromMinor
  });
}
test('operator sees a functional record form but not the review or audit controls',async()=>{
  const html=await page('Mobile Money Operator','mobile-money',{summary,canRecord:true,branches:[{status:'active',_id:'aaaaaaaaaaaaaaaaaaaaaaaa',name:'Main'}],canReview:false,reviewQueue:[],idempotencyKey:'123'});
  assert.match(html,/Record cash in/);
  assert.match(html,/name="_csrf" value="abc123"/);
  assert.doesNotMatch(html,/Independent internal review/);
  assert.doesNotMatch(html,/Audit Trail/);
});
test('reconciliation officer sees review form but not an unusable record form',async()=>{
  const html=await page('Reconciliation Officer','mobile-money',{summary,canRecord:false,canReview:true,reviewQueue:[record],idempotencyKey:'123'});
  assert.match(html,/Independent internal review/);
  assert.match(html,/name="decision" value="accepted"/);
  assert.doesNotMatch(html,/Record cash in/);
  assert.match(html,/Audit Trail/);
});
test('auditor sees read-only activity without fake submission buttons',async()=>{
  const html=await page('Auditor','mobile-money',{summary,canRecord:false,canReview:false,reviewQueue:[],idempotencyKey:'123'});
  assert.match(html,/Network activity/);
  assert.doesNotMatch(html,/Record cash in/);
  assert.doesNotMatch(html,/Independent internal review/);
});
test('report separates provider status and review and audit pages render tenant data safely',async()=>{
  const report={rows:[{module:'Mobile Money',activity:'MTN · cash_in',status:'pending_verification / awaiting_review',currency:'UGX',count:1,volume:'UGX 1,500',fees:'UGX 25'}],
    filters:{from:'',to:'',source:'all'},sources:[{key:'workspace',label:'Workspace activity'},{key:'mobile_money',label:'Mobile Money'}],total:1,
    note:'No amounts are confirmed settled.'};
  const html=await page('Auditor','reports',{report,canExport:true});
  assert.match(html,/Operations reporting hub/);
  assert.match(html,/Mobile Money/);
  assert.match(html,/pending verification/);
  const audit=await page('Auditor','audit',{logs:[{createdAt:new Date(),actorId:record.operatorId,action:'mobile_money.review.accepted',targetId:record._id}]});
  assert.match(audit,/mobile_money\.review\.accepted/);
});
