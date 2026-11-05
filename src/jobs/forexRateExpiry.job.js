'use strict';
// Runs only with an explicitly supplied trusted tenant cursor and connector.
async function run({tenants,connectionForTenant,now=new Date(),limit=100}={}){
 if(!tenants||typeof tenants[Symbol.asyncIterator]!=='function'||typeof connectionForTenant!=='function')
  throw Error('An authenticated tenant cursor and connection resolver are required');
 if(!(now instanceof Date)||!Number.isFinite(now.getTime())||!Number.isSafeInteger(limit)||limit<1||limit>200)throw Error('Invalid Forex expiry sweep parameters');
 let visited=0,expiredRates=0,expiredQuotes=0;
 for await(const tenant of tenants){
  const slug=String(tenant?.slug||'');
  if(!/^[a-z0-9][a-z0-9-]{2,78}$/.test(slug))throw Error('Invalid tenant slug in Forex expiry job');
  const result=await require('../tenant/services/forex.service').expireDue(connectionForTenant(slug),now,limit);
  visited++;expiredRates+=result.expiredRates;expiredQuotes+=result.expiredQuotes;
 }
 return {visited,expiredRates,expiredQuotes};
}
module.exports={run};
