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


// The committed record is the retry source; notification failures never
// change cash/float bookkeeping or the result returned to the operator.
function cursor(rows){return {select(){return this;},sort(){return this;},limit(){return this;},async lean(){return rows;}};}
function fixture({fail=false}={}){
 const record={_id:'507f1f77bcf86cd799439011',operatorId:'507f1f77bcf86cd799439012',
  branchId:'507f1f77bcf86cd799439013',network:'MTN',riskSignals:['rapid_repeat']};
 const owner={_id:'507f1f77bcf86cd799439014'};
 const state={synced:false,notices:new Map(),updates:0};
 const tenantModels={
  mobileTransactionModel:()=>({find:()=>cursor(state.synced?[]:[record]),
   updateOne:async()=>{state.synced=true;state.updates++;}}),
  tenantUserModel:()=>({find:()=>cursor([owner])}),
  notificationMessageModel:()=>({exists:async()=>null,
   updateOne:async(filter,update)=>{
    if(fail)throw new Error('Notification store temporarily unavailable');
    if(!state.notices.has(filter.dedupeKey))state.notices.set(filter.dedupeKey,update.$setOnInsert);
   }})
 };
 return {state,tenantModels};
}
test('anomaly worker creates one owner notice and finishes the durable outbox task',async()=>{
 const {dispatchPending}=require('../src/tenant/services/mobileMoneyRisk.service');
 const {state,tenantModels}=fixture();
 assert.equal(await dispatchPending(null,{tenantModels}),1);
 assert.equal(state.updates,1);
 assert.equal(state.notices.size,1);
 assert.equal(await dispatchPending(null,{tenantModels}),0);
 const notice=[...state.notices.values()][0];
 assert.equal(notice.source,'risk_alert');
 assert.equal(notice.emailState,'pending');
 assert.match(notice.body,/does not prove external provider settlement/);
});
test('anomaly alert storage outage leaves the original risk record pending',async()=>{
 const {dispatchPending}=require('../src/tenant/services/mobileMoneyRisk.service');
 const {state,tenantModels}=fixture({fail:true});
 await assert.rejects(dispatchPending(null,{tenantModels}),/temporarily unavailable/);
 assert.equal(state.synced,false);
 assert.equal(state.updates,0);
});
