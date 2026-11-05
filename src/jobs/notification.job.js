'use strict';
// Called only with a trusted tenant cursor/connection resolver, never by an
// unauthenticated HTTP endpoint. The production worker uses the same service.
async function run({tenants,connectionForTenant,mailer,workerId,limit=100}={}){
 if(!tenants||typeof tenants[Symbol.asyncIterator]!=='function'||typeof connectionForTenant!=='function'
  ||typeof mailer!=='function'||!/^[-a-z0-9]{8,80}$/i.test(String(workerId||'')))
  throw Error('Authenticated tenant cursor, connection resolver, mailer and worker ID are required');
 if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid notification sweep limit');
 let visited=0,processed=0;
 const service=require('../tenant/services/notification.service');
 for await (const tenant of tenants){
  if(!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(String(tenant?.slug||'')))throw Error('Invalid tenant identifier');
  const conn=connectionForTenant(tenant.slug);
  for(let i=0;i<limit;i++){
   const response=await service.processOne(conn,tenant,workerId,mailer);
   if(!response)break;processed++;
  }
  visited++;
 }
 return {visited,processed};
}
module.exports={run};
