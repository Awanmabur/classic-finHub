'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ledger=require('../src/tenant/services/ledger.service');
const schemas=require('../src/tenant/ledger/schemas');
const {tenantUserModel,ledgerAccountModel,ledgerJournalModel,ledgerPostingModel}=require('../src/tenant/models');
const mongoose=require('mongoose');
const id='507f1f77bcf86cd799439011';
const other='507f1f77bcf86cd799439012';
function sample(extra={}) {return {branchId:id,actorId:other,sourceType:'mobile_money',sourceRef:'provider:receipt:123',currency:'UGX',lines:[
  {accountCode:'CASH_UGX',side:'debit',amountMinor:'1000'},
  {accountCode:'FLOAT_MTN',side:'credit',amountMinor:'1000'}],...extra};}
test('reject malformed, unbalanced, zero, decimal and unsafe ledger postings',()=>{
  assert.equal(ledger.validateJournal(sample()).lines.length,2);
  for(const bad of ['0','-1','1.1','1e6','01','1000000000000000000',Number.NaN])
    assert.throws(()=>ledger.validateJournal(sample({lines:[{accountCode:'CASH_UGX',side:'debit',amountMinor:bad},
      {accountCode:'FLOAT_MTN',side:'credit',amountMinor:'1000'}]})));
  for(const bad of [[],[{accountCode:'CASH_UGX',side:'credit',amountMinor:'1000'}],
    [{accountCode:'CASH_UGX',side:'debit',amountMinor:'1000'},{accountCode:'FLOAT_MTN',side:'credit',amountMinor:'999'}],
    [{accountCode:'CASH_UGX',side:'debit',amountMinor:'1000'},{accountCode:'CASH_UGX',side:'credit',amountMinor:'1000'}]])
    assert.throws(()=>ledger.validateJournal(sample({lines:bad})));
  assert.throws(()=>ledger.validateJournal(sample({sourceType:'reversal'})));
  assert.throws(()=>ledger.validateJournal(sample({sourceType:'manual_adjustment'})));
  assert.throws(()=>ledger.validateJournal(sample({branchId:'outside'})));
  assert.throws(()=>ledger.validateJournal(sample({currency:'JPY'})));
});
test('idempotency fingerprint is deterministic and rejects changed economics',()=>{
  const a=ledger.validateJournal(sample());
  assert.equal(a.fingerprint,ledger.validateJournal(sample({lines:[...sample().lines].reverse()})).fingerprint);
  assert.notEqual(a.fingerprint,ledger.validateJournal(sample({lines:[{accountCode:'CASH_UGX',side:'debit',amountMinor:'2000'},
      {accountCode:'FLOAT_MTN',side:'credit',amountMinor:'2000'}]})).fingerprint);
  assert.notEqual(a.fingerprint,ledger.validateJournal(sample({branchId:other})).fingerprint);
});
test('reversal requires separate parties and traceable explanation',()=>{
  const valid={journalId:id,requestedBy:id,approvedBy:other,reason:'Provider settled in error, confirmed by incident case',ticketRef:'case:incident:1234'};
  assert.equal(ledger.normalizeReversal(valid).approvedBy,other);
  assert.throws(()=>ledger.normalizeReversal({...valid,approvedBy:id}));
  assert.throws(()=>ledger.normalizeReversal({...valid,reason:'oops'}));
  assert.throws(()=>ledger.normalizeReversal({...valid,ticketRef:'x'}));
});
test('separate strict append-only ledger models have essential unique indexes',()=>{
  const conn=mongoose.createConnection();
  const account=ledgerAccountModel(conn),journal=ledgerJournalModel(conn),posting=ledgerPostingModel(conn);
  assert(account.schema.indexes().some(([keys,opts])=>keys.branchId===1&&keys.code===1&&opts.unique));
  assert(journal.schema.indexes().some(([keys,opts])=>keys.sourceType===1&&keys.sourceRef===1&&opts.unique));
  assert(journal.schema.indexes().some(([keys,opts])=>keys.reverses===1&&opts.unique));
  assert(posting.schema.indexes().some(([keys,opts])=>keys.journalId===1&&keys.lineNo===1&&opts.unique));
  for(const model of [account,journal,posting])assert.equal(model.schema.options.strict,'throw');
  assert.equal(typeof tenantUserModel(conn),'function');
  conn.destroy();
});
test('public routes cannot post arbitrary ledger journal or bypass provider verification',()=>{
  const root=path.join(__dirname,'../src/tenant');
  function scan(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(d=>d.isDirectory()?scan(path.join(dir,d.name)):[path.join(dir,d.name)]);}
  for(const p of scan(path.join(root,'routes'))){const s=fs.readFileSync(p,'utf8');
    assert(!/ledger\.service|postJournal|reverseJournal|createAccount/.test(s),`Financial posting unexpectedly exposed in ${p}`);}
  assert.throws(()=>ledger.postEntry({amount:100}), e=>e.status===501);
});
