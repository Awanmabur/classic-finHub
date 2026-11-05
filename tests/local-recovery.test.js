'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyReplicaPrimary } = require('../src/config/mongoTopology');
const { getTransactions } = require('../src/tenant/services/mobileMoney.service');

test('financial runtime rejects standalone MongoDB and replica sets without a primary', () => {
  assert.throws(() => verifyReplicaPrimary({ isWritablePrimary:true }), /standalone/);
  assert.throws(() => verifyReplicaPrimary({ setName:'rs0', isWritablePrimary:false }), /not ready/);
  assert.throws(() => verifyReplicaPrimary(null), /could not be verified/);
  assert.deepEqual(verifyReplicaPrimary({setName:'rs0',isWritablePrimary:true}),{replicaSet:'rs0',writablePrimary:true});
});

test('dashboard list remains usable above 5,000 records; full CSV export refuses truncation', async () => {
  let counts=0, mostRecentLimit;
  const model={
    countDocuments:async()=>{ counts++; return 6500; },
    find:()=>({sort:()=>({limit:n=>{mostRecentLimit=n;return{lean:async()=>[{customer:'test'}]};}})})
  };
  const conn={models:{SecureMobileTransaction:model}};
  assert.equal((await getTransactions(conn,{limit:60})).length,1);
  assert.equal(counts,0);
  assert.equal(mostRecentLimit,60);
  await assert.rejects(getTransactions(conn,{limit:5000}), /more than 5,000 records/);
  assert.equal(counts,1);
  await getTransactions(conn,{limit:'invalid'});
  assert.equal(mostRecentLimit,60);
});
