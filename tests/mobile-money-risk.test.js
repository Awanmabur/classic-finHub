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


// The notification worker never mutates cash, float or financial transactions.
function rows(items){return {select(){return this;},sort(){return this;},limit(){return this;},async lean(){return items;}};}
function fixture({fail=false}={}){
 const at=new Date('2026-11-16T10:00:00Z');
 const record={_id:'507f1f77bcf86cd799439011',operatorId:'507f1f77bcf86cd799439012',
  branchId:'507f1f77bcf86cd799439013',network:'MTN',riskSignals:['rapid_repeat'],createdAt:at};
 const owner={_id:'507f1f77bcf86cd799439014'};
 const state={cursor:null,notices:new Map(),financialWrites:0};
 const tenantModels={
  mobileTransactionModel:()=>({find:()=>rows(state.cursor?[]:[record]),
   updateOne:async()=>{state.financialWrites++;}}),
  tenantUserModel:()=>({find:()=>rows([owner])}),
  riskAlertDispatchCursorModel:()=>({
   findOne:()=>({lean:async()=>state.cursor}),
   create:async()=>{state.cursor={lastCreatedAt:at,lastId:record._id};},
   updateOne:async()=>({matchedCount:1})
  }),
  notificationMessageModel:()=>({exists:async()=>null,
   updateOne:async(filter,change)=>{
    if(fail)throw Error('Notification storage unavailable');
    if(!state.notices.has(filter.dedupeKey))state.notices.set(filter.dedupeKey,change.$setOnInsert);
   }})
 };
 return {state,tenantModels};
}
test('risk worker upserts owner notice and only updates notification-owned checkpoint',async()=>{
 const {dispatchPending}=require('../src/tenant/services/mobileMoneyRisk.service');
 const {state,tenantModels}=fixture(),now=new Date('2026-11-16T10:05:00Z');
 assert.equal(await dispatchPending(null,{tenantModels,now}),1);
 assert.equal(state.financialWrites,0);
 assert.equal(state.notices.size,1);
 assert(state.cursor);
 assert.equal(await dispatchPending(null,{tenantModels,now}),0);
 const alert=[...state.notices.values()][0];
 assert.equal(alert.source,'risk_alert');
 assert.equal(alert.emailState,'pending');
 assert.match(alert.body,/does not prove external provider settlement/);
});
test('notification storage failure leaves pending source and retry position unchanged',async()=>{
 const {dispatchPending}=require('../src/tenant/services/mobileMoneyRisk.service');
 const {state,tenantModels}=fixture({fail:true});
 await assert.rejects(dispatchPending(null,{tenantModels,now:new Date('2026-11-16T10:05:00Z')}),/Notification storage unavailable/);
 assert.equal(state.cursor,null);
 assert.equal(state.financialWrites,0);
});
test('new risk alerts are dispatched without advancing a potentially unsafe cursor',async()=>{
 const {dispatchPending}=require('../src/tenant/services/mobileMoneyRisk.service');
 const {state,tenantModels}=fixture();
 assert.equal(await dispatchPending(null,{tenantModels,now:new Date('2026-11-16T10:00:20Z')}),1);
 assert.equal(state.notices.size,1);
 assert.equal(state.cursor,null);
});
