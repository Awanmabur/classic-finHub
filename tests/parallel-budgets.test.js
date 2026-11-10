'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Model=require('../src/platform/models/LoginThrottle');
const login=require('../src/platform/services/loginThrottle.service');
const actions=require('../src/platform/services/actionThrottle.service');
function pending(t){
 const jobs=[];
 t.mock.method(Model,'findOneAndUpdate',filter=>({lean:()=>new Promise((resolve,reject)=>jobs.push({filter,resolve,reject}))}));
 return jobs;
}
test('sign-in and recovery start both shared budgets and enforce their original limits',async t=>{
 const jobs=pending(t),attempt=login.consumeAttempt('budget@example.invalid','127.0.0.1',1800000);
 assert.equal(jobs.length,2,'independent counters must start together');
 assert.match(jobs[0].filter._id,/^ip:/);assert.match(jobs[1].filter._id,/^email:/);
 jobs[0].resolve({count:1});jobs[1].resolve({count:9});await assert.rejects(attempt,error=>error.status===429);
 const recovery=login.consumeRecoveryAttempt('budget@example.invalid','127.0.0.1',1800000);
 assert.equal(jobs.length,4);jobs[2].resolve({count:3});jobs[3].resolve({count:31});await assert.rejects(recovery,error=>error.status===429);
});
test('a rejected financial budget waits for both writes and retains user-first error priority',async t=>{
 const jobs=pending(t),headers={},response={setHeader:(name,value)=>{headers[name]=value;}},req={tenant:{id:'507f1f77bcf86cd799439011'},user:{id:'507f1f77bcf86cd799439012'}};
 let finished=false,result;
 const work=actions.financial(req,response,error=>{finished=true;result=error;});
 assert.equal(jobs.length,2);assert.match(jobs[0].filter._id,/^rate:money-user:/);assert.match(jobs[1].filter._id,/^rate:money-tenant:/);
 jobs[0].resolve({count:121});await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);
 jobs[1].resolve({count:601});await work;assert.equal(result.status,429);assert(headers['Retry-After']);
 const primary=Error('primary'),secondary=Error('secondary');finished=false;
 const retry=actions.financial(req,response,error=>{finished=true;result=error;});
 jobs[3].reject(secondary);await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);
 jobs[2].reject(primary);await retry;assert.equal(result,primary);
});
