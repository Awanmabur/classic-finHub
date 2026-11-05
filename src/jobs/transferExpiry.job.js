'use strict';
// Production-safe bounded sweep; no dummy statuses and no customer data logged.
// Never posts ledger entries, collects money or initiates payout.
async function run({tenants,connectionForTenant,now=new Date(),limit=100}={}){
 if(!tenants||typeof tenants[Symbol.asyncIterator]!=='function'||typeof connectionForTenant!=='function')
  throw new Error('Transfer expiry requires a tenant cursor and connection factory');
 const {expireDue}=require('../tenant/services/moneyTransfer.service');
 let inspected=0,expired=0,remaining=false;
 for await(const tenant of tenants){
  const slug=String(tenant.slug||'');
  if(!/^[a-z0-9][a-z0-9-]{2,78}$/.test(slug))throw new Error('Invalid tenant slug in expiry job');
  const result=await expireDue(connectionForTenant(slug),now,limit);
  inspected++;expired+=result.expired;if(result.scanned===limit)remaining=true;
 }
 return {inspectedTenants:inspected,expiredRequests:expired,possiblyMoreDue:remaining};
}
module.exports={run};
