#!/usr/bin/env node
'use strict';
// Explicit one-tenant, backup-confirmed migration. Never infer that a legacy
// indicative price was an executable Buy or Sell price.
const mongoose=require('mongoose');
const {connectPlatformMongo,getTenantConnection,tenantDbNameFromSlug}=require('../src/config/mongo');
const Tenant=require('../src/platform/models/Tenant');
const {forexRateModel}=require('../src/tenant/models');
const OLD='one_active_forex_rate_per_pair';
const NEW='one_active_forex_rate_per_pair_side';
const args=process.argv.slice(2);
const slugArg=args.find(a=>a.startsWith('--tenant='));
const slug=slugArg?slugArg.slice('--tenant='.length):'';
const apply=args.includes('--apply');
if(!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(slug) ||
 args.some(a=>a!==slugArg&&!['--apply','--maintenance-confirmed','--backup-verified'].includes(a)))
 throw Error('Usage: node scripts/forex-rate-side-migrate.js --tenant=SLUG [--apply --maintenance-confirmed --backup-verified]');
if(apply&&(!args.includes('--maintenance-confirmed')||!args.includes('--backup-verified')))
 throw Error('Production writes must be paused and a restorable backup independently verified first');
function expected(index,withSide){
 const keys=['branchId','fromCurrency','toCurrency',...(withSide?['side']:[])];
 return !!(index&&index.unique===true&&index.partialFilterExpression?.status==='active'&&
  Object.keys(index.key||{}).length===keys.length&&keys.every(k=>index.key[k]===1));
}
async function main(){
 await connectPlatformMongo();
 const tenant=await Tenant.findOne({slug}).select('slug dbName').lean();
 if(!tenant||tenant.dbName!==tenantDbNameFromSlug(slug))throw Error('Unknown tenant or unexpected tenant database name');
 const conn=getTenantConnection(slug),collection=forexRateModel(conn).collection;
 const hello=await conn.db.admin().command({hello:1});
 if(!hello.setName||!hello.isWritablePrimary)throw Error('Writable MongoDB replica-set primary required');
 let indexes;
 try{indexes=await collection.indexes();}
 catch(e){if(e.codeName==='NamespaceNotFound')indexes=[];else throw e;}
 const old=indexes.find(i=>i.name===OLD),newer=indexes.find(i=>i.name===NEW);
 if(old&&!expected(old,false))throw Error('Unexpected legacy index definition; stop for investigation');
 if(newer&&!expected(newer,true))throw Error('Unexpected replacement index definition; stop for investigation');
 const unclassified=await collection.countDocuments({side:{$exists:false}});
 console.log(JSON.stringify({tenant:slug,database:conn.name,legacyRates:unclassified,oldIndex:!!old,newIndex:!!newer,apply}));
 if(!apply){console.log('DRY RUN: nothing changed');return;}
 // This operation must run with all Forex rate/quote writes paused.
 await collection.updateMany({side:{$exists:false}},{$set:{side:'quote'}});
 await collection.createIndex({branchId:1,fromCurrency:1,toCurrency:1,side:1},
  {name:NEW,unique:true,partialFilterExpression:{status:'active'}});
 const verified=await collection.indexes();
 if(!expected(verified.find(i=>i.name===NEW),true))throw Error('New unique index not verified: old index remains');
 if(await collection.countDocuments({side:{$exists:false}}))throw Error('Unclassified legacy rates remain: old index remains');
 if(old)await collection.dropIndex(OLD);
 const final=await collection.indexes();
 if(final.some(i=>i.name===OLD)||!expected(final.find(i=>i.name===NEW),true))
  throw Error('New index verification failed after cutover');
 console.log('PASS: Buy and Sell use separate unique rate slots; legacy rates remain quote-only');
}
main().catch(e=>{console.error('FOREX MIGRATION BLOCKED:',e.message);process.exitCode=1;})
 .finally(()=>mongoose.disconnect().catch(()=>{}));
