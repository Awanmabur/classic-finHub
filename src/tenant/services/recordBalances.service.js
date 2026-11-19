'use strict';
// Read-only historical account snapshots from committed append-only Treasury
// movements. Never infer a past balance by subtracting subsequent transactions.
const {models}=require('../treasury/models');
const {hasPermission}=require('./moduleAccess.service');
const {formatMoneyMinor}=require('./mobileMoney.service');
const {Types}=require('mongoose');
const OID=/^[a-f0-9]{24}$/i;
const SUPERVISORS=new Set(['Tenant Owner','Auditor','Branch Manager','Reconciliation Officer']);
const MAX_SOURCES=120,MAX_MOVEMENTS=1000;

function canRead(actor,account){
 if(!hasPermission(actor,'treasury.view'))return false;
 if(['Tenant Owner','Auditor'].includes(actor.role))return true;
 if(String(account.branchId)!==String(actor.branchId||''))return false;
 if(SUPERVISORS.has(actor.role))return true;
 return account.operatorId==null||String(account.operatorId)===String(actor.id);
}
function entry(source,account,movement){
 return {stage:source.stage||'Posted',account:account.name,
  kind:account.kind,currency:movement.currency,
  change:formatMoneyMinor(movement.deltaMinor,movement.currency),
  balanceAfter:formatMoneyMinor(movement.balanceAfterMinor,movement.currency),
  occurredAt:movement.occurredAt,sequence:movement.sequence};
}
async function snapshots(conn,tenant,actor,sources=[]){
 const output=new Map();
 if(!hasPermission(actor,'treasury.view')||!sources.length)return output;
 if(sources.length>MAX_SOURCES)throw Error('Too many historical balance sources');
 const seen=new Map();
 for(const source of sources){
  if(!OID.test(String(source.recordId||''))||!['mobile_money','forex','banking','money_transfer'].includes(source.sourceType))continue;
  if(typeof source.sourceRef!=='string'||source.sourceRef.length>120)continue;
  const key=source.sourceType+'|'+source.sourceRef;
  if(!seen.has(key))seen.set(key,[]);
  seen.get(key).push(source);
 }
 if(!seen.size)return output;
 const kinds=[...new Set([...seen.keys()].map(key=>key.split('|')[0]))];
 const refs=[...new Set([...seen.keys()].map(key=>key.slice(key.indexOf('|')+1)))];
 const {batch:Batch,movement:Movement,account:Account}=models(conn);
 const allowedBranches=SUPERVISORS.has(actor.role)&&['Tenant Owner','Auditor'].includes(actor.role)?{}:
  OID.test(String(actor.branchId||''))?{branchId:new Types.ObjectId(String(actor.branchId))}:null;
 if(allowedBranches===null)return output;
 const batches=await Batch.find({tenantId:tenant._id,...allowedBranches,
  sourceType:{$in:kinds},sourceRef:{$in:refs}})
  .select('_id sourceType sourceRef').limit(MAX_SOURCES+1).maxTimeMS(5000).lean();
 if(batches.length>MAX_SOURCES)throw Error('Too many matching historical batches');
 if(!batches.length)return output;
 const movements=await Movement.find({tenantId:tenant._id,...allowedBranches,
  batchId:{$in:batches.map(row=>row._id)}})
  .select('batchId accountId currency deltaMinor balanceAfterMinor sequence occurredAt')
  .limit(MAX_MOVEMENTS+1).maxTimeMS(5000).lean();
 if(movements.length>MAX_MOVEMENTS)throw Error('Too many historical account movements');
 const accounts=await Account.find({tenantId:tenant._id,...allowedBranches,
  _id:{$in:movements.map(row=>row.accountId)}})
  .select('_id branchId operatorId name kind currency')
  .limit(MAX_MOVEMENTS).maxTimeMS(5000).lean();
 const byAccount=new Map(accounts.filter(a=>canRead(actor,a)).map(a=>[String(a._id),a]));
 const byBatch=new Map();
 for(const movement of movements){
  const account=byAccount.get(String(movement.accountId));
  if(!account||account.currency!==movement.currency)continue;
  const key=String(movement.batchId);
  if(!byBatch.has(key))byBatch.set(key,[]);
  byBatch.get(key).push({movement,account});
 }
 for(const batch of batches){
  const sourcesForBatch=seen.get(batch.sourceType+'|'+batch.sourceRef)||[];
  for(const source of sourcesForBatch){
   const key=String(source.recordId);
   if(!output.has(key))output.set(key,[]);
   for(const {account,movement} of byBatch.get(String(batch._id))||[])
    output.get(key).push(entry(source,account,movement));
  }
 }
 for(const entries of output.values())
  entries.sort((a,b)=>a.currency.localeCompare(b.currency)||a.stage.localeCompare(b.stage)||
   a.kind.localeCompare(b.kind)||a.account.localeCompare(b.account));
 return output;
}
// Called only after the existing record detail handler authorizes the source.
// A quote/request without a posted Treasury batch has no historical balance.
async function forRecord(conn,tenant,actor,key,record){
 if(!hasPermission(actor,'treasury.view')||!record?._id)return [];
 const sources=[];
 if(key==='mobile_money'&&record.fundingState==='book_recorded'&&record.fundsSourceRef)
  sources.push({recordId:record._id,sourceType:record.fundsSourceRef.startsWith('MFX:')?'forex':'mobile_money',sourceRef:record.fundsSourceRef,stage:'Cash / float'});
 if(key==='forex'&&record.originModule==='mobile_money'&&record.status==='posted_manual'&&
    /^[a-f0-9-]{36}$/i.test(String(record.idempotencyKey||'')))
  sources.push({recordId:record._id,sourceType:'forex',sourceRef:'MFX:'+record.idempotencyKey,stage:'Linked Mobile Money / Forex'});
 if(['forex','banking','money_transfer'].includes(key)){
  const executions=await require('../funded/models').models(conn).execution.find({
   sourceType:key,sourceId:record._id,status:'posted_manual'
  }).select('_id action').limit(6).maxTimeMS(5000).lean();
  for(const exec of executions){
   sources.push({recordId:record._id,sourceType:key,sourceRef:'FUNDED:'+exec._id,
    stage:exec.action==='transfer_collect'?'Cash collection':exec.action==='transfer_payout'?'Cash payout':'Posted movement'});
   if(key==='money_transfer'&&exec.action==='transfer_payout')
    sources.push({recordId:record._id,sourceType:key,sourceRef:'BRANCH_PAYOUT:'+exec._id+':ORIGIN',stage:'Origin branch transfer'});
  }
 }
 return (await snapshots(conn,tenant,actor,sources)).get(String(record._id))||[];
}
module.exports={snapshots,forRecord,canRead};
