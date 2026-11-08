'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),ejs=require('ejs'),path=require('node:path');
const service=require('../src/tenant/services/fundedOperations.service'),pin=require('../src/tenant/funded/pin');
const ids=Array.from({length:6},()=>crypto.randomBytes(12).toString('hex'));
function rows(plan){return plan.ledgerLines.map(line=>[line.currency,line.accountId,line.side,line.amountMinor]);}
test('manual banking plans post real customer liabilities and never invent an opening balance',()=>{
 const s={sourceType:'banking',currency:'UGX',amountMinor:'10000',kind:'deposit_request'};
 const account={cashAccountId:ids[0]},counter={sourceLiabilityId:ids[1],destinationLiabilityId:ids[2]};
 assert.deepEqual(service.economicPlan(s,account,counter),{legs:[{accountId:ids[0],deltaMinor:'10000'}],ledgerLines:[{currency:'UGX',accountId:ids[1],side:'credit',amountMinor:'10000'}]});
 const withdrawal=service.economicPlan({...s,kind:'withdrawal_request'},account,counter);assert.equal(withdrawal.legs[0].deltaMinor,'-10000');assert.equal(withdrawal.ledgerLines[0].side,'debit');
 const transfer=service.economicPlan({...s,kind:'transfer_request'},account,counter);assert.equal(transfer.legs.length,0);assert.deepEqual(rows(transfer),[['UGX',ids[1],'debit','10000'],['UGX',ids[2],'credit','10000']]);
});
test('manual FX stock and settlement movements use exact minor units with explicit actually collected fees',()=>{
 const base={sourceType:'forex',operation:'buy',fromCurrency:'USD',toCurrency:'UGX',sourceMinor:'1000',targetMinor:'37000',feeMinor:'100'},accounts={foreignAccountId:ids[0],settlementAccountId:ids[1]};
 const buy=service.economicPlan(base,accounts,{feeIncomeId:ids[2]});assert.deepEqual(buy.legs,[{accountId:ids[0],deltaMinor:'1000'},{accountId:ids[1],deltaMinor:'-36900'}]);assert.deepEqual(rows(buy),[['UGX',ids[2],'credit','100']]);
 const sell=service.economicPlan({...base,operation:'sell'},accounts,{feeIncomeId:ids[2]});assert.deepEqual(sell.legs,[{accountId:ids[0],deltaMinor:'-1000'},{accountId:ids[1],deltaMinor:'37100'}]);
 assert.throws(()=>service.economicPlan({...base,feeMinor:'37000'},accounts,{feeIncomeId:ids[2]}),{status:409});
});
test('manual remittance collection records transfer payable and explicit fee income separately',()=>{
 const value=service.economicPlan({sourceType:'money_transfer',currency:'USD',amountMinor:'25000',feeMinor:'125'},{collectionAccountId:ids[0],clearingAccountId:ids[1]},{feeIncomeId:ids[2]});
 assert.deepEqual(value.legs,[{accountId:ids[0],deltaMinor:'25125'},{accountId:ids[1],deltaMinor:'25000'}]);assert.equal(value.ledgerLines[0].amountMinor,'125');
});
test('manual settlement account selection rejects ambiguous network defaults and other operators balances',()=>{
 const options={kind:'wallet',currency:'UGX',actorId:ids[0]};
 const shared={_id:ids[1],kind:'wallet',currency:'UGX',status:'active',operatorId:null,selectionKey:'shared:MTN'};
 const assigned={...shared,_id:ids[2],operatorId:ids[0],selectionKey:'assigned:MTN'};
 const otherNetwork={...assigned,_id:ids[3],selectionKey:'assigned:Airtel'};
 const otherOperator={...assigned,_id:ids[4],operatorId:ids[5],selectionKey:'other:MTN'};
 assert.equal(service.choose([shared,assigned],null,options),ids[2]);
 assert.equal(service.choose([assigned,shared],ids[1],options),ids[1]);
 assert.throws(()=>service.choose([assigned,otherNetwork],null,options),{status:409});
 assert.throws(()=>service.choose([otherNetwork,assigned],null,options),{status:409});
 assert.equal(service.choose([assigned,otherNetwork],ids[3],options),ids[3]);
 assert.throws(()=>service.choose([otherOperator],ids[4],options),{status:409});
 assert.throws(()=>service.choose([{...shared,selectionKey:null},{...shared,_id:ids[3],selectionKey:null}],null,options),{status:409});
 assert.throws(()=>service.choose([shared],ids[1],{...options,kind:'cash'}),{status:409});
});
test('cash drawer detail restricts every operating role to its own drawer while supervisors retain branch review',async()=>{
 const cash=require('../src/tenant/services/cashDrawer.service');
 const {entitledTenant}=require('./helpers/entitlement');
 const modules=['mobile_money','money_transfer','banking','forex'];
 const tenant=entitledTenant({enabledModules:modules});
 const ownDrawer={_id:ids[1],operatorId:ids[0],branchId:ids[2]},otherDrawer={_id:ids[3],operatorId:ids[4],branchId:ids[2]};
 const conn={models:{SecureCashSession:{findOne:filter=>({lean:async()=>{
  const row=String(filter._id)===ids[1]?ownDrawer:otherDrawer;
  return (!filter.branchId||String(filter.branchId)===row.branchId)&&(!filter.operatorId||String(filter.operatorId)===row.operatorId)?row:null;
 }})}}};
 for(const role of ['Mobile Money Operator','Money Transfer Operator','Banking Operator','Forex Operator']){
  const actor={id:ids[0],branchId:ids[2],role,allowedModules:modules};
  assert.equal((await cash.detail(conn,tenant,actor,ids[1]))._id,ids[1]);
  await assert.rejects(cash.detail(conn,tenant,actor,ids[3]),{status:404});
 }
 assert.equal((await cash.detail(conn,tenant,{id:ids[5],branchId:ids[2],role:'Branch Manager',allowedModules:modules},ids[3]))._id,ids[3]);
});
test('payout PIN storage is domain-separated, bound to tenant/branch/receiver and not reusable ciphertext',()=>{
 const previous=process.env.MFA_ENCRYPTION_KEY;process.env.MFA_ENCRYPTION_KEY=crypto.randomBytes(32).toString('hex');
 try{const value=pin.generate();assert.match(value,/^\d{6}$/);const scope={tenantId:ids[0],branchId:ids[1],phone:'+256700123456'};const digest=pin.hash(value,scope);assert.match(digest,/^[a-f0-9]{64}$/);assert.notEqual(digest,pin.hash(value,{...scope,phone:'+256700123457'}));assert.notEqual(digest,pin.hash(value,{...scope,branchId:ids[2]}));const encrypted=pin.encrypt(value,'database:execution:source');assert(!encrypted.includes(value));assert.equal(pin.decrypt(encrypted,'database:execution:source'),value);assert.throws(()=>pin.decrypt(encrypted,'other:execution:source'));assert.throws(()=>pin.normalPhone('0700123456'));}finally{if(previous===undefined)delete process.env.MFA_ENCRYPTION_KEY;else process.env.MFA_ENCRYPTION_KEY=previous;}
});
test('payout form uses one protected MVC stage and cannot pay before a matched receiver',async()=>{
 const file=path.resolve(__dirname,'../src/views/tenant/funded/payout.ejs');const html=await ejs.renderFile(file,{data:{verification:null,idempotencyKey:crypto.randomUUID()},csrfToken:'csrf'});
 for(const field of ['PIN','Sender phone','Receiver name check','ID / Passport presented','Payout note','Match','Amount','Status'])assert(html.includes(field));
 assert.match(html,/name="phase" value="check"/);assert.match(html,/name="_csrf" value="csrf"/);assert.match(html,/<button class="btn" type="submit" disabled>Pay out cash/);assert.doesNotMatch(html,/name="branchId"/);
});

test('sender-phone PIN lookup is versioned and cannot be downgraded to receiver verification',()=>{
 const previous=process.env.MFA_ENCRYPTION_KEY;process.env.MFA_ENCRYPTION_KEY=crypto.randomBytes(32).toString('hex');
 try{const scope={tenantId:ids[0],branchId:ids[1],phone:'+256700123456'};assert.notEqual(pin.hash('123456',scope),pin.hash('123456',{...scope,version:'sender_v2'}));assert.deepEqual(service.payoutLookup({senderPhone:scope.phone}),{phone:scope.phone,version:'sender_v2'});assert.deepEqual(service.payoutLookup({legacyReceiverPhone:scope.phone}),{phone:scope.phone,version:'receiver_v1'});assert.throws(()=>service.payoutLookup({senderPhone:scope.phone,receiverPhone:scope.phone}),{status:400});assert.throws(()=>service.payoutLookup({senderPhone:'0700123456'}),{status:400});}finally{if(previous===undefined)delete process.env.MFA_ENCRYPTION_KEY;else process.env.MFA_ENCRYPTION_KEY=previous;}
});
test('legacy manual transfer fingerprints remain valid without rewriting their immutable snapshots',()=>{
 const source={_id:ids[0],branchId:ids[1],createdBy:ids[2],reference:'TR-LEGACY',currency:'UGX',amountMinor:'10000',feeMinor:'100',sender:{name:'Sender',phone:'+256700111222'},beneficiary:{name:'Receiver',phone:'+256700123456'},capture:{method:'Cash'}};
 const current=service.sourceSnapshot('money_transfer',source),old={...current};delete old.senderPhone;delete old.senderName;
 const execution={sourceType:'money_transfer',sourceSnapshot:old,sourceFingerprint:crypto.createHash('sha256').update(JSON.stringify(old)).digest('hex')};
 assert.equal(service.sourceMatches(execution,source),true);assert.equal(service.sourceMatches(execution,{...source,amountMinor:'20000'}),false);
 const fresh={sourceType:'money_transfer',sourceSnapshot:current,sourceFingerprint:crypto.createHash('sha256').update(JSON.stringify(current)).digest('hex')};assert.equal(service.sourceMatches(fresh,source),true);assert.equal(service.sourceMatches(fresh,{...source,sender:{...source.sender,phone:'+256700999999'}}),false);
});

test('receiver SMS always names the selected destination, including a reconstructed retry',()=>{const message=service.transferMessage({reference:'TR-TEST',currency:'UGX',amountMinor:'10000',sender:{name:'Sender',phone:'+211921234567'},destinationBranchName:'Receiving Office'},{name:'Sending Office'},'123456');assert.match(message,/Collect at Receiving Office/);assert.doesNotMatch(message,/Collect at Sending Office/);});
