'use strict';
// Cross-module Forex orders require a real, already funded Banking/Transfer
// record. An FX trade never changes the origin request's provider status.
const models=require('../models');
const OID=/^[a-f0-9]{24}$/i;
function fail(message,status=409){return Object.assign(new Error(message),{status});}
function originId(input,module){
 if(module==='forex'){
  if(input!==undefined&&input!==null&&input!=='')throw fail('Standalone Forex cannot claim an external source order',400);
  return null;
 }
 if(!['banking','money_transfer'].includes(module)||!OID.test(String(input||'')))
  throw fail('Choose an actual completed Banking or collected Money Transfer instruction before converting its currency',400);
 return String(input).toLowerCase();
}
async function verify(conn,session,actor,branchId,quote){
 const module=quote.originModule||'forex';
 const sourceId=originId(quote.originRecordId,module);
 if(!sourceId)return null;
 const Model=module==='banking'?models.bankingRequestModel(conn):models.transferOrderModel(conn);
 const filter={_id:sourceId,branchId,
  ...(actor.role==='Tenant Owner'?{}:{createdBy:actor.id})};
 const query=Model.findOne(filter);
 if(session)query.session(session);
 const source=await query.lean();
 if(!source)throw fail('Original Banking/Transfer instruction not found in this branch or operator scope',403);
 const state=module==='banking'?'posted_manual':'collected_manual';
 if(source.status!==state)throw fail(module==='banking'?
  'Record and verify the actual banking movement before starting its currency exchange':
  'Record and verify the actual transfer collection before its currency exchange');
 const from=String(quote.fromCurrency),to=String(quote.toCurrency);
 const sourceMinor=BigInt(String(quote.sourceMinor)),targetMinor=BigInt(String(quote.targetMinor));
 const original=BigInt(String(source.amountMinor));
 if(original<=0n||(
   !(source.currency===from&&sourceMinor>0n&&sourceMinor<=original) &&
   !(source.currency===to&&targetMinor>0n&&targetMinor<=original)
  ))throw fail('The currency exchange must use a currency and an amount no larger than the actual collected source instruction',409);
 return source;
}
module.exports={originId,verify};
