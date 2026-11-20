'use strict';
// Mobile Money owner rates are managed inside existing deposit/withdrawal UX.
// Quotes remain normalized as target units per ONE source unit.
const {forexRateModel,branchModel,auditEventModel,ensureTenantIndexes}=require('../models');
const {hasModuleForUser,hasPermission}=require('./moduleAccess.service');
const {currencies}=require('../../config/currencies');
const rateUnits=require('./forexRateUnits.service');
const auth=require('./financialAuthorization.service');
function fail(message,status=400){return Object.assign(new Error(message),{status});}
function inputRate(body){
 const fromCurrency=String(body?.fromCurrency||''),toCurrency=String(body?.toCurrency||'');
 if(!Object.hasOwn(currencies,fromCurrency)||!Object.hasOwn(currencies,toCurrency)||fromCurrency===toCurrency)
  throw fail('Choose two different supported operating currencies');
 const side=String(body?.side||'');
 if(!['buy','sell'].includes(side))throw fail('Choose Buy or Sell rate');
 const validHours=Number(body?.validHours||24);
 if(!Number.isSafeInteger(validHours)||validHours<1||validHours>72)throw fail('Rate validity must be 1–72 hours');
 let rateDecimal;
 try{rateDecimal=rateUnits.normalize({quotedRate:body?.quotedRate,rateBaseUnits:body?.rateBaseUnits});}
 catch(e){throw fail(e.message);}
 return {fromCurrency,toCurrency,side,validHours,rateDecimal};
}
function canManageRate(actor){
 return ['Tenant Owner','Branch Manager'].includes(actor?.role)&&
  hasPermission(actor,'treasury.manage')&&hasPermission(actor,'mobile_money.view')&&
  hasPermission(actor,'forex.rate_manage')&&hasPermission(actor,'forex.rate_review');
}
async function setOwnerRate(conn,tenant,actor,branch,input){
 if(!canManageRate(actor)||!hasModuleForUser(tenant,actor,'mobile_money'))
  throw fail('An authorized owner or assigned branch manager is required to set exchange rates',403);
 if(!branch?._id||branch.status!=='active')throw fail('Choose an active operating branch',409);
 const v=inputRate(input);
 await ensureTenantIndexes(conn);
 const session=await conn.startSession();
 try{return await session.withTransaction(async()=>{
  const fenced=await auth.fenceAction(conn,session,actor,tenant,'mobile_money','mobile_money.view',{branchId:String(branch._id)});
  if(!canManageRate(fenced.actor))throw fail('Exchange rate authority changed. Refresh before saving.',403);
  const active=await branchModel(conn).findOneAndUpdate({_id:branch._id,status:'active'},{$inc:{revision:1}},{session,new:true}).lean();
  if(!active||![v.fromCurrency,v.toCurrency].every(code=>require('./branchCurrency.service').supports(active,code)))
   throw fail('Both exchange currencies must be enabled on the branch',409);
  const Rate=forexRateModel(conn),opposite=v.side==='buy'?'sell':'buy';
  const other=await Rate.findOne({branchId:active._id,fromCurrency:v.fromCurrency,toCurrency:v.toCurrency,
   side:opposite,status:'active',expiresAt:{$gt:new Date()}}).session(session).lean();
  if(other){
   const scaled=require('./forex.service').rateScaled;
   if(v.side==='buy'?scaled(v.rateDecimal)>=scaled(other.rateDecimal):scaled(v.rateDecimal)<=scaled(other.rateDecimal))
    throw fail('Buy rate must be lower than Sell rate for this pair',409);
  }
  await Rate.updateMany({branchId:active._id,fromCurrency:v.fromCurrency,toCurrency:v.toCurrency,side:v.side,status:'active'},
   {$set:{status:'superseded'},$inc:{revision:1}},{session});
  const [rate]=await Rate.create([{branchId:active._id,fromCurrency:v.fromCurrency,toCurrency:v.toCurrency,
   side:v.side,rateDecimal:v.rateDecimal,status:'active',proposedBy:fenced.actor.id,
   reviewedBy:fenced.actor.id,reviewedAt:new Date(),revision:1,
   expiresAt:new Date(Date.now()+v.validHours*3600000),
   note:'Tenant-authorized operating rate for Mobile Money and shared Forex'}],{session});
  await auditEventModel(conn).create([{action:'mobile_money.fx.rate.activated',actorId:fenced.actor.id,targetId:rate._id,
   metadata:{branchId:String(active._id),pair:v.fromCurrency+'/'+v.toCurrency,side:v.side,rateDecimal:v.rateDecimal}}],{session});
  return rate;
 });}
 catch(e){if(e.code===11000)throw fail('A concurrent rate update occurred. Refresh and retry',409);throw e;}
 finally{await session.endSession();}
}
module.exports={inputRate,canManageRate,setOwnerRate};
