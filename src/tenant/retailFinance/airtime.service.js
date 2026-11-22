'use strict';
// Airtime transactions are MANUAL, confirmed against an external provider
// reference. We never claim this code delivers telecom airtime automatically.
// Inventory is tracked at its actual purchase cost, not face value.
const F=require('./security'),{models,ensure}=require('./airtime.models');
const treasury=require('../treasury/service');
const {resolve:branchCurrency}=require('../services/branchCurrency.service');
const {reserveUsage}=require('../../platform/services/commercial.service');
function network(value){const n=F.clean(value,'airtime provider',2,50);if(!/^[A-Za-z0-9][A-Za-z0-9 .+_-]{1,49}$/.test(n))throw F.fail('Enter a valid airtime network name');return n;}
const proof=(value)=>F.clean(value,'verified provider reference',6,120);
function amountPair(input,currency){
 const denom=F.amount(input.denomination,currency),cost=F.amount(input.cost,currency),price=F.amount(input.price,currency);
 if(price<cost)throw F.fail('The selling price cannot be lower than the configured acquisition cost',409);
 return {denom,cost,price};
}
async function createProduct(conn,tenant,actor,input){
 let current=await F.access(conn,tenant,actor,'airtime','airtime.manage');
 if(!['Tenant Owner','Branch Manager'].includes(current.actor.role))throw F.fail('Only owners and branch managers can configure airtime pricing',403);
 const branch=await F.operatingBranch(conn,current.actor,input),currency=branchCurrency(branch,input.currency),
  values=amountPair(input,currency),n=network(input.network),name=F.clean(input.name,'product label',3,100);
 await ensure(conn);
 return F.transact(conn,async session=>{
  current=await F.access(conn,tenant,actor,'airtime','airtime.manage',session);
  const active=await F.operatingBranch(conn,current.actor,input,session);
  if(String(active._id)!==String(branch._id))throw F.fail('Operating branch changed',409);
  const [product]=await models(conn).product.create([{tenantId:current.tenant._id,branchId:active._id,
   currency,network:n,name,denominationMinor:F.d(values.denom),costMinor:F.d(values.cost),
   priceMinor:F.d(values.price),createdBy:F.oid(current.actor.id)}],{session});
  await F.audit(conn,session,current.actor,product._id,'airtime.product.created',{branchId:String(active._id),
   network:n,currency,denominationMinor:String(values.denom),costMinor:String(values.cost),priceMinor:String(values.price)});
  return product;
 });
}
async function inventoryInSession(conn,session,tenantId,branchId,networkName,currency){
 const Stock=models(conn).inventory,filter={tenantId,branchId,network:networkName,currency};
 const row=await Stock.findOneAndUpdate(filter,{$setOnInsert:{...filter,costBalanceMinor:F.d(0),revision:0}},
   {upsert:true,new:true,session});
 if(!row)throw F.fail('Airtime inventory is unavailable',503);
 return row;
}
function fingerprint(type,actor,fields){return F.hash({type,actorId:String(actor.id),...fields});}
async function purchase(conn,tenant,actor,input){
 let current=await F.access(conn,tenant,actor,'airtime','airtime.manage');
 if(!['Tenant Owner','Branch Manager'].includes(current.actor.role))throw F.fail('Only an owner or branch manager may record a funded stock purchase',403);
 const branch=await F.operatingBranch(conn,current.actor,input),currency=branchCurrency(branch,input.currency);
 const n=network(input.network),amount=F.amount(input.cost,currency),key=F.uuid(input.idempotencyKey),
  accountId=F.oid(input.accountId,'funding account'),reference=proof(input.reference);
 const fp=fingerprint('stock_purchase',actor,{network:n,currency,cost:String(amount),accountId:String(accountId),reference});
 await Promise.all([ensure(conn),require('../treasury/models').ensure(conn)]);
 const prior=await models(conn).record.findOne({idempotencyKey:key}).lean();
 if(prior){if(prior.fingerprint!==fp)throw F.fail('Stock purchase reference has conflicting details',409);return {record:prior,duplicate:true};}
 return F.transact(conn,async session=>{
  current=await F.access(conn,tenant,actor,'airtime','airtime.manage',session);
  const active=await F.operatingBranch(conn,current.actor,input,session);
  if(String(active._id)!==String(branch._id))throw F.fail('Operating branch changed',409);
  const auth=await treasury.access(conn,current.tenant,current.actor,{permission:'treasury.observe',session,fence:true,sourceType:'airtime'});
  const fund=await F.funds(conn,auth,accountId,active._id,currency,session);
  const stock=await inventoryInSession(conn,session,current.tenant._id,active._id,n,currency);
  const before=BigInt(String(stock.costBalanceMinor)),after=before+amount;
  if(after>999999999999999999n)throw F.fail('Inventory amount exceeds supported bounds',409);
  const changed=await models(conn).inventory.findOneAndUpdate({_id:stock._id,revision:stock.revision},
   {$set:{costBalanceMinor:F.d(after),lastActivityAt:new Date()},$inc:{revision:1}},{session,new:true});
  if(!changed)throw F.fail('Stock changed concurrently',409);
  const inventoryLedger=await treasury.ensureCounterAccount(conn,session,{tenantId:current.tenant._id,branchId:active._id,currency,
   purpose:'airtime_inventory',actorId:current.actor.id});
  const batch=await treasury.applyMovements(conn,session,auth,{sourceType:'airtime',sourceRef:'AIR:STOCK:'+key,
   branchId:String(active._id),legs:[{accountId:String(fund._id),deltaMinor:'-'+amount}],
   ledgerLines:[{accountId:String(inventoryLedger.ledgerAccountId),currency,side:'debit',amountMinor:String(amount)}],
   description:'Verified prepaid airtime stock purchase '+n,evidenceRef:reference});
  await reserveUsage(current.tenant,'airtime_stock',session);
  const [record]=await models(conn).record.create([{tenantId:current.tenant._id,branchId:active._id,inventoryId:stock._id,
   type:'stock_purchase',idempotencyKey:key,fingerprint:fp,network:n,currency,costMinor:F.d(amount),
   accountId:fund._id,reference,batchId:batch.batch._id,createdBy:F.oid(current.actor.id)}],{session});
  await F.audit(conn,session,current.actor,record._id,'airtime.stock.purchased',{branchId:String(active._id),
   costMinor:String(amount),currency,network:n,batchId:String(batch.batch._id)});
  return {record,duplicate:false};
 });
}
async function sell(conn,tenant,actor,input){
 let current=await F.access(conn,tenant,actor,'airtime','airtime.sell');
 if(input.deliveryConfirmed!=='yes')throw F.fail('Record a sale only after verifying actual airtime delivery',409);
 const key=F.uuid(input.idempotencyKey),productId=F.oid(input.productId,'airtime product'),
  accountId=F.oid(input.accountId,'receiving funds account'),reference=proof(input.reference);
 const phone=F.clean(input.phone,'customer phone',9,20);
 if(!/^\+[1-9][0-9]{7,14}$/.test(phone))throw F.fail('Enter the customer phone in international format, such as +211...',400);
 const fp=fingerprint('sale',actor,{productId:String(productId),accountId:String(accountId),reference,phone});
 await Promise.all([ensure(conn),require('../treasury/models').ensure(conn)]);
 const prior=await models(conn).record.findOne({idempotencyKey:key}).lean();
 if(prior){if(prior.fingerprint!==fp)throw F.fail('Airtime sale reference has conflicting details',409);return {record:prior,duplicate:true};}
 return F.transact(conn,async session=>{
  current=await F.access(conn,tenant,actor,'airtime','airtime.sell',session);
  const p=await models(conn).product.findOne({_id:productId,tenantId:current.tenant._id,status:'active',...F.scope(current.actor)}).session(session).lean();
  if(!p)throw F.fail('Airtime product is unavailable in your branch',409);
  const active=await F.operatingBranch(conn,current.actor,input,session);
  if(String(active._id)!==String(p.branchId))throw F.fail('Sale must be recorded at the product branch',409);
  branchCurrency(active,p.currency);
  const auth=await treasury.access(conn,current.tenant,current.actor,{permission:'treasury.observe',session,fence:true,sourceType:'airtime'});
  const fund=await F.funds(conn,auth,accountId,p.branchId,p.currency,session);
  const stock=await models(conn).inventory.findOne({tenantId:current.tenant._id,branchId:p.branchId,network:p.network,currency:p.currency}).session(session).lean();
  const cost=BigInt(String(p.costMinor)),retail=BigInt(String(p.priceMinor)),denom=BigInt(String(p.denominationMinor));
  if(!stock||BigInt(String(stock.costBalanceMinor))<cost)throw F.fail('Insufficient purchased airtime stock. Record a real stock purchase first.',409);
  const remaining=BigInt(String(stock.costBalanceMinor))-cost;
  const updated=await models(conn).inventory.findOneAndUpdate({_id:stock._id,revision:stock.revision},
   {$set:{costBalanceMinor:F.d(remaining),lastActivityAt:new Date()},$inc:{revision:1}},{session,new:true});
  if(!updated)throw F.fail('Airtime stock changed. Reload before selling.',409);
  const inventory=await treasury.ensureCounterAccount(conn,session,{tenantId:current.tenant._id,branchId:p.branchId,currency:p.currency,
   purpose:'airtime_inventory',actorId:current.actor.id});
  const profit=retail-cost;
  const income=profit>0n?await treasury.ensureCounterAccount(conn,session,{tenantId:current.tenant._id,branchId:p.branchId,currency:p.currency,
   purpose:'airtime_profit_income',actorId:current.actor.id}):null;
  const batch=await treasury.applyMovements(conn,session,auth,{sourceType:'airtime',sourceRef:'AIR:SALE:'+key,branchId:String(p.branchId),
   legs:[{accountId:String(fund._id),deltaMinor:String(retail)}],
   ledgerLines:[{currency:p.currency,accountId:String(inventory.ledgerAccountId),side:'credit',amountMinor:String(cost)},
    ...(profit>0n?[{currency:p.currency,accountId:String(income.ledgerAccountId),side:'credit',amountMinor:String(profit)}]:[])],
   description:'Manually verified '+p.network+' airtime delivery to '+phone,evidenceRef:reference});
  await reserveUsage(current.tenant,'airtime_sales',session);
  const [record]=await models(conn).record.create([{tenantId:current.tenant._id,branchId:p.branchId,inventoryId:stock._id,
   productId:p._id,type:'sale',idempotencyKey:key,fingerprint:fp,network:p.network,currency:p.currency,
   phone,denominationMinor:F.d(denom),costMinor:F.d(cost),retailMinor:F.d(retail),profitMinor:F.d(profit),
   accountId:fund._id,reference,batchId:batch.batch._id,createdBy:F.oid(current.actor.id)}],{session});
  await F.audit(conn,session,current.actor,record._id,'airtime.sale.recorded',{branchId:String(p.branchId),currency:p.currency,
   network:p.network,costMinor:String(cost),profitMinor:String(profit),batchId:String(batch.batch._id)});
  return {record,duplicate:false};
 });
}
function summarize(records){
 const byCurrency=new Map();
 for(const r of records){
  const key=r.currency,group=byCurrency.get(key)||{currency:key,sales:0n,cost:0n,profit:0n,purchases:0n};
  if(r.type==='sale'){group.sales+=BigInt(String(r.retailMinor));group.cost+=BigInt(String(r.costMinor));group.profit+=BigInt(String(r.profitMinor));}
  else group.purchases+=BigInt(String(r.costMinor));
  byCurrency.set(key,group);
 }
 return [...byCurrency.values()].map(x=>Object.fromEntries(Object.entries(x).map(([k,v])=>[k,typeof v==='bigint'?String(v):v])));
}
async function actualSummary(conn,tenantId,filter){
 const rows=await models(conn).record.aggregate([
  {$match:{tenantId,...filter}},
  {$group:{_id:'$currency',
   sales:{$sum:{$cond:[{$eq:['$type','sale']},'$retailMinor',{$toDecimal:'0'}]}},
   cost:{$sum:{$cond:[{$eq:['$type','sale']},'$costMinor',{$toDecimal:'0'}]}},
   profit:{$sum:{$cond:[{$eq:['$type','sale']},'$profitMinor',{$toDecimal:'0'}]}},
   purchases:{$sum:{$cond:[{$eq:['$type','stock_purchase']},'$costMinor',{$toDecimal:'0'}]}}
  }}
 ]);
 return rows.map(row=>({currency:row._id,sales:String(row.sales||'0'),cost:String(row.cost||'0'),
  profit:String(row.profit||'0'),purchases:String(row.purchases||'0')}));
}
async function list(conn,tenant,actor){
 const current=await F.access(conn,tenant,actor,'airtime','airtime.view'),scope={tenantId:current.tenant._id,...F.scope(current.actor)};
 const [products,inventory,records,summary]=await Promise.all([
  models(conn).product.find(scope).sort({createdAt:-1}).limit(150).lean(),
  models(conn).inventory.find(scope).sort({network:1}).limit(150).lean(),
  models(conn).record.find(scope).sort({createdAt:-1}).limit(200).lean(),
  actualSummary(conn,current.tenant._id,F.scope(current.actor))
 ]);
 return {products,inventory,records,summary};
}
module.exports={createProduct,purchase,sell,list,summarize,amountPair};
