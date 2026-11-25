'use strict';
// Airtime transactions are MANUAL, confirmed against an external provider
// reference. We never claim this code delivers telecom airtime automatically.
// Inventory is tracked at its actual purchase cost, not face value.
const F=require('./security'),{models,ensure}=require('./airtime.models');
const treasury=require('../treasury/service');
const {resolve:branchCurrency}=require('../services/branchCurrency.service');
const {reserveUsage}=require('../../platform/services/commercial.service');
function network(value){const n=F.clean(value,'airtime provider',2,50).toUpperCase();if(!/^[A-Za-z0-9][A-Za-z0-9 .+_-]{1,49}$/.test(n))throw F.fail('Enter a valid airtime network name');return n;}
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
 try { return await F.transact(conn,async session=>{
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
 }catch(error){
  if(error.code===11000||error.code===112||error.hasErrorLabel?.('TransientTransactionError')){
   const item=await models(conn).record.findOne({idempotencyKey:key}).lean();
   if(item&&item.fingerprint===fp)return {record:item,duplicate:true};
  }
  throw error;
 }
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
 try { return await F.transact(conn,async session=>{
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
 }catch(error){
  if(error.code===11000||error.code===112||error.hasErrorLabel?.('TransientTransactionError')){
   const item=await models(conn).record.findOne({idempotencyKey:key}).lean();
   if(item&&item.fingerprint===fp)return {record:item,duplicate:true};
  }
  throw error;
 }
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
async function reverseRecorded(conn,tenant,actor,recordId,input){
 const id=F.oid(recordId,'airtime transaction'),reason=F.clean(input.reason,'correction reason',12,400),
  reference=proof(input.reference);
 if(input.providerReversed!=='yes'||input.fundsReturned!=='yes')
  throw F.fail('Confirm the actual provider reversal and the matching money refund before correcting this transaction',409);
 await Promise.all([ensure(conn),require('../treasury/models').ensure(conn)]);
 return F.transact(conn,async session=>{
  const current=await F.access(conn,tenant,actor,'airtime','airtime.review',session);
  if(!['Tenant Owner','Branch Manager','Reconciliation Officer'].includes(current.actor.role))
   throw F.fail('Independent authorized reviewer required',403);
  const record=await models(conn).record.findOne({_id:id,tenantId:current.tenant._id,...F.scope(current.actor)}).session(session).lean();
  if(!record)throw F.fail('Airtime record cannot be corrected in your branch',404);
  if(String(record.createdBy)===String(current.actor.id))
   throw F.fail('Another authorized person must independently review an airtime correction',409);
  const earlier=await models(conn).correction.find({inventoryId:record.inventoryId,tenantId:current.tenant._id})
   .select('recordId').session(session).lean();
  if(earlier.some(item=>String(item.recordId)===String(id)))
   throw F.fail('This transaction was already reversed',409);
  const latest=await models(conn).record.findOne({
   inventoryId:record.inventoryId,_id:{$nin:earlier.map(item=>item.recordId)}
  }).sort({createdAt:-1,_id:-1}).session(session).lean();
  if(!latest||String(latest._id)!==String(id))
   throw F.fail('Reverse later stock/sale activity first to avoid misstated airtime inventory',409);
  const inventory=await models(conn).inventory.findOne({tenantId:current.tenant._id,_id:record.inventoryId,branchId:record.branchId})
   .session(session).lean();
  if(!inventory)throw F.fail('Actual airtime stock account is missing',409);
  const cost=BigInt(String(record.costMinor)),old=BigInt(String(inventory.costBalanceMinor));
  const after=record.type==='sale'?old+cost:old-cost;
  if(after<0n||after>999999999999999999n)throw F.fail('Airtime stock cannot balance after the proposed reversal',409);
  const auth=await treasury.access(conn,current.tenant,current.actor,{
   permission:'treasury.review',session,fence:true,sourceType:'airtime'});
  // Treasury reverses exactly the original posted cash/wallet/bank ledger, not an
  // invented refund or a second sale; the supplier/provider refund is attested above.
  const reversal=await treasury.reverseMovements(conn,session,auth,{
   sourceType:'airtime',batchId:record.batchId,
   reversalSourceRef:'AIR:REV:'+id,
   description:'Independent provider-confirmed airtime reversal: '+reason,
   evidenceReference:reference});
  const updated=await models(conn).inventory.findOneAndUpdate({_id:inventory._id,revision:inventory.revision},{
   $set:{costBalanceMinor:F.d(after),lastActivityAt:new Date()},$inc:{revision:1}
  },{session,new:true});
  if(!updated)throw F.fail('Inventory changed during reversal',409);
  const [correction]=await models(conn).correction.create([{tenantId:current.tenant._id,branchId:record.branchId,
   recordId:id,inventoryId:record.inventoryId,reversalBatchId:reversal.batch._id,
   type:record.type,currency:record.currency,amountMinor:record.type==='sale'?record.retailMinor:record.costMinor,
   costMinor:record.costMinor,profitMinor:record.profitMinor,reference,reason,createdBy:F.oid(current.actor.id)
  }],{session});
  await F.audit(conn,session,current.actor,id,'airtime.transaction.reversed',{
   branchId:String(record.branchId),originalRecordId:String(id),reversalBatchId:String(reversal.batch._id),
   providerReversed:true,fundsReturned:true,reason,reference});
  return correction;
 });
}
async function actualSummary(conn,tenantId,filter){
 const [originals,reversals]=await Promise.all([
  models(conn).record.aggregate([
   {$match:{tenantId,...filter}},
   {$group:{_id:'$currency',
    sales:{$sum:{$cond:[{$eq:['$type','sale']},'$retailMinor',{$toDecimal:'0'}]}},
    cost:{$sum:{$cond:[{$eq:['$type','sale']},'$costMinor',{$toDecimal:'0'}]}},
    profit:{$sum:{$cond:[{$eq:['$type','sale']},'$profitMinor',{$toDecimal:'0'}]}},
    purchases:{$sum:{$cond:[{$eq:['$type','stock_purchase']},'$costMinor',{$toDecimal:'0'}]}}
   }}
  ]),
  models(conn).correction.aggregate([
   {$match:{tenantId,...filter}},
   {$group:{_id:'$currency',
    sales:{$sum:{$cond:[{$eq:['$type','sale']},'$amountMinor',{$toDecimal:'0'}]}},
    cost:{$sum:{$cond:[{$eq:['$type','sale']},'$costMinor',{$toDecimal:'0'}]}},
    profit:{$sum:{$cond:[{$eq:['$type','sale']},'$profitMinor',{$toDecimal:'0'}]}},
    purchases:{$sum:{$cond:[{$eq:['$type','stock_purchase']},'$costMinor',{$toDecimal:'0'}]}}
   }}
  ])
 ]);
 const totals=new Map();
 const apply=(r,sign)=>{
  if(!totals.has(r._id))totals.set(r._id,{currency:r._id,sales:0n,cost:0n,profit:0n,purchases:0n});
  const target=totals.get(r._id);
  for(const key of ['sales','cost','profit','purchases'])target[key]+=sign*BigInt(String(r[key]||'0'));
 };
 originals.forEach(r=>apply(r,1n));reversals.forEach(r=>apply(r,-1n));
 return [...totals.values()].sort((a,b)=>a.currency.localeCompare(b.currency))
  .map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,typeof v==='bigint'?String(v):v])));
}
async function list(conn,tenant,actor,{operatingBranchId}={}){
 const current=await F.access(conn,tenant,actor,'airtime','airtime.view');
 const tenantId=current.tenant._id,branch=F.scope(current.actor),scope={tenantId,...branch};
 const model=models(conn);
 const [products,inventory,records,summary]=await Promise.all([
  model.product.find({tenantId,...F.productScope(current.actor,operatingBranchId)}).sort({createdAt:-1}).limit(150).lean(),
  model.inventory.find(scope).sort({network:1}).limit(150).lean(),
  model.record.find(scope).sort({createdAt:-1,_id:-1}).limit(200).lean(),
  actualSummary(conn,tenantId,branch)
 ]);
 const corrections=records.length?await model.correction.find({
  ...scope,recordId:{$in:records.map(record=>record._id)}
 }).lean():[];
 return {products,inventory,records,summary,corrections};
}
module.exports={createProduct,purchase,sell,reverseRecorded,list,summarize,amountPair};
