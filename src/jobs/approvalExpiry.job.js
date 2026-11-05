'use strict';
// Tenant discovery must be provided by a trusted authenticated system cursor.
async function run({tenants,connectionForTenant,now=new Date(),limit=100}={}){
 if(!tenants||typeof tenants[Symbol.asyncIterator]!=='function'||typeof connectionForTenant!=='function')
  throw Error('Authenticated tenant cursor and connection resolver required');
 if(!(now instanceof Date)||!Number.isFinite(now.getTime())||!Number.isSafeInteger(limit)||limit<1||limit>200)
  throw Error('Invalid approval expiry parameters');
 let visited=0,expired=0;
 for await (const tenant of tenants){
  const slug=String(tenant?.slug||'');
  if(!/^[a-z0-9][a-z0-9-]{2,78}$/.test(slug))throw Error('Invalid tenant slug in approval expiry job');
  expired+=await require('../tenant/services/approvals.service').expireDue(connectionForTenant(slug),now,limit);visited++;
 }
 return {visited,expired};
}
module.exports={run};
