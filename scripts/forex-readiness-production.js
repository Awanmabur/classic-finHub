#!/usr/bin/env node
'use strict';
// Production read-only tally. This does not approve providers or move money.
const mongoose=require('mongoose');
const {connectPlatformMongo,getTenantConnection}=require('../src/config/mongo');
const Tenant=require('../src/platform/models/Tenant');
const {grants,records}=require('../src/tenant/schemas/MomoFxSettlement');
const {forexRateModel}=require('../src/tenant/models');
const {models:funded}=require('../src/tenant/funded/models');
async function main(){
 if(process.env.NODE_ENV!=='production')throw Error('Production runtime required');
 await connectPlatformMongo();
 const filter={status:{$in:['active','trial']}},total=await Tenant.countDocuments(filter);
 if(total>250)throw Error('More than 250 tenants: use paginated read-only inspection');
 const tenants=await Tenant.find(filter).select('_id slug').limit(251).lean();
 const now=new Date(),state={tenants:tenants.length,activeComplianceGrants:0,activeBuySellRates:0,postedForex:0,postedCrossCurrency:0};
 for(const t of tenants){
  const conn=getTenantConnection(t.slug);
  const [a,b,c,d]=await Promise.all([
   grants(conn).countDocuments({tenantId:t._id,status:'approved',expiresAt:{$gt:now},providerAuthorizationReference:{$ne:''},regulatoryAuthorizationReference:{$ne:''}}),
   forexRateModel(conn).countDocuments({status:'active',side:{$in:['buy','sell']},expiresAt:{$gt:now}}),
   funded(conn).execution.countDocuments({sourceType:'forex',status:'posted_manual'}),
   records(conn).countDocuments({tenantId:t._id})
  ]);
  state.activeComplianceGrants+=a;state.activeBuySellRates+=b;state.postedForex+=c;state.postedCrossCurrency+=d;
 }
 console.log('FOREX_READINESS',JSON.stringify({postingSwitchEnabled:process.env.CLASSICFIN_MOMO_FX_POSTING_ENABLED==='true',...state}));
 if(!state.activeComplianceGrants)console.log('ACTION REQUIRED: No active authorized provider/currency grants. Cross-currency posting remains blocked for those branches.');
 if(!state.activeBuySellRates)console.log('ACTION REQUIRED: No currently active Buy/Sell exchange rates.');
 console.log('Counts are not proof of external provider settlement or regulatory clearance.');
}
main().catch(error=>{console.error('READINESS_ERROR',error.code||error.message);process.exitCode=1;})
.finally(()=>mongoose.disconnect().catch(()=>{}));
