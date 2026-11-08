#!/usr/bin/env node
'use strict';
// Only isolated scratch databases on the local replica set are created/dropped.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const path=require('node:path');
const mongoose=require('mongoose');
const express=require('express');
const ejs=require('ejs');
const env=require('../src/config/env');
const {verifyReplicaPrimary}=require('../src/config/mongoTopology');
const models=require('../src/tenant/models');
const workspace=require('../src/tenant/services/operationWorkspace.service');
const {permissionsFor}=require('../src/config/roles');
const {entitledTenant}=require('../tests/helpers/entitlement');
const routes=require('../src/tenant/routes/operationWorkspace.routes');
const fundedRoutes=require('../src/tenant/routes/fundedOperations.routes');
const Tenant=require('../src/platform/models/Tenant');
const {tenantDbNameFromSlug}=require('../src/config/tenantDatabaseName');
async function main(){
 const uri=new URL(env.mongoPlatformUri);
 if(env.nodeEnv==='production'||uri.protocol!=='mongodb:'||!['127.0.0.1','localhost','[::1]'].includes(uri.hostname)||uri.host.includes(','))throw Error('Only an isolated loopback MongoDB replica set is allowed');
 const nonce=crypto.randomBytes(8).toString('hex'),slugs=[`workspace-a-${nonce}`,`workspace-b-${nonce}`],names=slugs.map(tenantDbNameFromSlug),platformName=`classicfin_probe_workspaces_platform_${nonce}`;
 const conns=[];let server;
 const tenant=entitledTenant({plan:'finance',enabledModules:['banking','forex'],moduleGrants:[{moduleKey:'money_transfer',status:'granted',generation:1,periodStart:new Date('2026-01-01'),periodEnd:new Date('2030-01-01'),currency:'USD',priceMonthlyMinor:0,limits:{users:5,branches:5,recordsPerMonth:100}}]});
 const first=String(new mongoose.Types.ObjectId()),second=String(new mongoose.Types.ObjectId());
 const owner={id:first,authVersion:0,role:'Tenant Owner',permissions:['*'],allowedModules:['banking','forex','money_transfer']};
 try{
  const platformUri=new URL(uri);platformUri.pathname=`/${platformName}`;await mongoose.connect(platformUri.href,{serverSelectionTimeoutMS:10000});await Tenant.createIndexes();
  for(const name of names){uri.pathname=`/${name}`;const conn=await mongoose.createConnection(uri.href,{serverSelectionTimeoutMS:10000}).asPromise();conns.push(conn);await models.ensureTenantIndexes(conn);}
  verifyReplicaPrimary(await conns[0].db.admin().command({hello:1}));
  const [conn,other]=conns;
  const branches=await models.branchModel(conn).create([{name:'One',code:'one',currency:'UGX',createdBy:first,updatedBy:first},{name:'Two',code:'two',currency:'KES',createdBy:first,updatedBy:first}]);
  const branchId=String(branches[0]._id),otherBranch=String(branches[1]._id),date=new Date(),expires=new Date(Date.now()+86400000);
  owner.branchId=branchId;
  const trustedTenant=await Tenant.create({...tenant,name:'Workspace route probe',slug:slugs[0],dbName:conn.name,email:`workspace-${nonce}@example.invalid`,owner:'Scratch Owner',setupStatus:'complete'});Object.assign(tenant,trustedTenant.toObject());
  await models.tenantUserModel(conn).create([{_id:first,name:'Scratch Owner',email:`owner-${nonce}@example.invalid`,passwordHash:'scratch-not-a-real-password',role:'Tenant Owner',branchId,allowedModules:owner.allowedModules,status:'active',mfaEnabledAt:new Date(),authVersion:0},{_id:second,name:'Banking Operator',email:`operator-${nonce}@example.invalid`,passwordHash:'scratch-not-a-real-password',role:'Banking Operator',branchId,allowedModules:['banking'],status:'active',mfaEnabledAt:new Date(),authVersion:0}]);
  const ref=(prefix)=>`${prefix}-${crypto.randomBytes(8).toString('hex')}`;
  const account={referenceId:new mongoose.Types.ObjectId(),customerName:'Private banking customer',institutionName:'Scratch Bank',last4:'4321'};
  const contact={contactId:new mongoose.Types.ObjectId(),name:'Private transfer customer',phone:'+256700000001',country:'UG'};
  for(const [branchId,currency,maker,amount] of [[String(branches[0]._id),'UGX',first,'20000'],[String(branches[0]._id),'UGX',second,'7000'],[String(branches[1]._id),'KES',first,'12345']]){
   await models.transferOrderModel(conn).create({reference:ref('TR'),idempotencyKey:crypto.randomUUID(),branchId,createdBy:maker,sender:contact,beneficiary:{...contact,contactId:new mongoose.Types.ObjectId(),name:'Receiver'},currency,amountMinor:amount,feeMinor:'100',validDays:7,expiresAt:expires,status:'approved_pending_provider'});
   await models.bankingRequestModel(conn).create({reference:ref('BK'),idempotencyKey:crypto.randomUUID(),branchId,createdBy:maker,kind:'deposit_request',source:account,currency,amountMinor:amount,note:'Scratch integration request, no funds moved',validDays:7,expiresAt:expires});
   await models.forexQuoteModel(conn).create({reference:ref('FX'),idempotencyKey:crypto.randomUUID(),branchId,createdBy:maker,customerLabel:'Private forex customer',operation:maker===first?'buy':'sell',rateId:new mongoose.Types.ObjectId(),fromCurrency:currency,toCurrency:'USD',rateDecimal:'0.000275',sourceMinor:amount,targetMinor:'550',expiresAt:expires,validMinutes:15,note:'Scratch integration indicative quote'});
  }
  const filters={from:date.toISOString().slice(0,10),to:date.toISOString().slice(0,10)};
  for(const [key,role] of [['money_transfer','Money Transfer Operator'],['banking','Banking Operator'],['forex','Forex Operator']]){
   const actor={id:first,role,branchId,permissions:permissionsFor(role),allowedModules:[key]};
   const own=await workspace.records(conn,tenant,actor,key,{...filters,branchId:otherBranch});
   assert.equal(own.items.length,1);assert.equal(String(own.items[0].createdBy),first);assert.equal(String(own.items[0].branchId),branchId);
   const report=await workspace.report(conn,tenant,owner,key,filters);
   assert.equal(report.total,3);assert.equal(report.rows.length,key==='forex'?3:2);assert(report.rows.some(row=>row.currency==='KES'));assert(report.rows.some(row=>row.currency==='UGX'));
   assert(!workspace.csv(report).includes('Private'));assert(!workspace.csv(report).includes('4321'));assert(!workspace.csv(report).includes('+256'));
   assert.equal((await workspace.records(other,tenant,owner,key,filters)).items.length,0,'Tenant connection is isolated');
   await assert.rejects(workspace.report(conn,tenant,{...actor,allowedModules:[]},key,filters),{status:403});
  }
  const buy=await workspace.records(conn,tenant,owner,'forex',{...filters,kind:'buy'});assert.equal(buy.items.length,2);
  const sell=await workspace.report(conn,tenant,owner,'forex',{...filters,kind:'sell'});assert.equal(sell.total,1);assert.equal(sell.rows[0].target,'USD 5.50');
  const app=express();
  app.use((req,res,next)=>{req.tenantDb=conn;req.tenant=tenant;req.session={};req.user=req.headers['x-probe-role']==='operator'?{id:second,authVersion:0,role:'Banking Operator',branchId,permissions:permissionsFor('Banking Operator'),allowedModules:['banking']}:owner;next();});
  const renderTenant=(req,res,view,title,subtitle,data)=>ejs.renderFile(path.resolve(__dirname,`../src/views/tenant/${view}.ejs`),{data,user:req.user,csrfToken:'scratch'}).then(html=>res.send(html)).catch(error=>res.status(500).send(error.message));
  for(const key of ['money_transfer','banking','forex'])app.use(`/tenant/${workspace.definition(key).path}`,routes({moduleKey:key,renderTenant}));
  app.use('/tenant/funded',fundedRoutes({renderTenant}));
  app.use((error,req,res,next)=>res.status(error.status||500).send(error.message));
  server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
  const base=`http://127.0.0.1:${server.address().port}`,query=new URLSearchParams(filters);
  for(const [modulePath,subpaths] of [['money-transfer',['records','fees','pending-payouts','report']],['banking',['records','movements','report']],['forex',['records','cash-impact','report']]]){
   for(const subpath of subpaths){const response=await fetch(`${base}/tenant/${modulePath}/${subpath}?${query}`);assert.equal(response.status,200,`${modulePath}/${subpath}`);assert((await response.text()).includes('Apply filters'));}
   const csv=await fetch(`${base}/tenant/${modulePath}/report/export.csv?${query}`);assert.equal(csv.status,200);assert.match(csv.headers.get('content-type'),/text\/csv/);assert.match(await csv.text(),/Date \(UTC\)/);
  }
  const payoutRedirect=await fetch(`${base}/tenant/money-transfer/payout`,{redirect:'manual'});assert.equal(payoutRedirect.status,303);assert.equal(payoutRedirect.headers.get('location'),'/tenant/funded/payout');
  const payout=await fetch(new URL(payoutRedirect.headers.get('location'),base));assert.equal(payout.status,200);const payoutHtml=await payout.text();assert.match(payoutHtml,/data-payout-form/);assert.match(payoutHtml,/name="pin"/);assert.match(payoutHtml,/name="senderPhone"/);assert.match(payoutHtml,/name="legacyReceiverPhone"/);assert.match(payoutHtml,/name="_csrf" value="scratch"/);assert.match(payoutHtml,/Check PIN/);assert.match(payoutHtml,/<button[^>]+disabled[^>]*>Pay out cash<\/button>/);
  const unrelated={headers:{'x-probe-role':'operator'},redirect:'manual'};
  assert.equal((await fetch(`${base}/tenant/money-transfer/payout`,unrelated)).status,403,'Unassigned banking operator cannot enter payout through the legacy route');
  assert.equal((await fetch(`${base}/tenant/funded/payout`,unrelated)).status,403,'Direct funded access enforces the real module assignment and role');
  await Tenant.updateOne({_id:tenant._id},{$set:{status:'suspended'}});assert.equal((await fetch(`${base}/tenant/funded/payout`)).status,403,'Payout rechecks current tenant status against the platform database');await Tenant.updateOne({_id:tenant._id},{$set:{status:'active'}});
  const denied=await fetch(`${base}/tenant/banking/report/export.csv?${query}`,{headers:{'x-probe-role':'operator'}});assert.equal(denied.status,403);
  const invalid=await fetch(`${base}/tenant/forex/report?status=settled`);assert.equal(invalid.status,400);
  console.log('PASS: approved operation workspaces, real Mongo records/aggregates, currency separation, creator/branch/tenant isolation, FX direction, rendered routes, authenticated manual PIN payout redirect and controlled CSV exports');
 }finally{
  if(server)await new Promise(resolve=>server.close(resolve));
  for(let i=0;i<conns.length;i++){
   if(!/^classicfin_tenant_workspace_[ab]_[a-f0-9]{16}_db$/.test(names[i]))throw Error('Unsafe scratch database name');
   try{await conns[i].db.dropDatabase();}finally{await conns[i].close();}
  }
  if(mongoose.connection.readyState===1){if(!/^classicfin_probe_workspaces_platform_[a-f0-9]{16}$/.test(platformName)||mongoose.connection.name!==platformName)throw Error('Unsafe scratch platform database');await mongoose.connection.db.dropDatabase();}await mongoose.disconnect();
 }
}
main().catch(error=>{console.error('OPERATION WORKSPACES INTEGRATION FAILED:',error.stack||error.message);process.exitCode=1;});
