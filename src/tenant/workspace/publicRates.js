'use strict';
// Only business-approved public prices: never expose customer quotes or financial records.
const {hasModule}=require('../services/moduleAccess.service');
const {forexRateModel,branchModel}=require('../models');
const {display}=require('../services/forexRateUnits.service');
const businessTime=require('../../utils/businessTime');
const groupDecimal=value=>String(value).replace(/^(\d+)/,int=>int.replace(/\B(?=(\d{3})+(?!\d))/g,','));
async function publicRates(conn,tenant,now=new Date()){
 if(!tenant||!hasModule(tenant,'forex'))return [];
 const branches=await branchModel(conn).find({status:'active'}).select('_id name timeZone currency').limit(100).lean();
 if(!branches.length)return [];
 const byId=new Map(branches.map(b=>[String(b._id),{name:String(b.name||'Business branch').slice(0,90),zone:businessTime.forBranch(b)}]));
 const rates=await forexRateModel(conn).find({
  branchId:{$in:branches.map(b=>b._id)},status:'active',reviewedAt:{$exists:true,$ne:null},
  expiresAt:{$gt:now},side:{$in:['buy','sell','quote']}
 }).select('branchId fromCurrency toCurrency side rateDecimal expiresAt').sort({createdAt:-1}).limit(120).lean();
 return rates.flatMap(rate=>{
  if(!byId.has(String(rate.branchId)))return [];
  try{
   const quote=display(rate.rateDecimal,rate.fromCurrency),branch=byId.get(String(rate.branchId));
   return [{branch:branch.name,from:rate.fromCurrency==='KES'?'KSH':rate.fromCurrency,
    to:rate.toCurrency==='KES'?'KSH':rate.toCurrency,
    side:rate.side,base:quote.text,price:groupDecimal(quote.rate),expiresAt:rate.expiresAt,
    expiresLocal:businessTime.format(rate.expiresAt,branch.zone),timeZone:branch.zone}];
  }catch{return [];} // Never promote malformed stored rates publicly.
 });
}
// Public controls are copied from the tenant's audited, validated branding config.
async function publicBoard(conn,tenant,now=new Date()){
 const settingsDoc=await require('./models').models(conn).config.findOne({tenantId:tenant._id}).select('branding.publicRatesEnabled branding.rateBoardTitle branding.rateBoardNote branding.rateBoardStyle').lean();
 const saved=settingsDoc?.branding||{};
 const settings={enabled:saved.publicRatesEnabled!==false,
  title:typeof saved.rateBoardTitle==='string'&&saved.rateBoardTitle.trim()?saved.rateBoardTitle:'Current exchange rates',
  note:typeof saved.rateBoardNote==='string'?saved.rateBoardNote:'Business-approved rates; confirm the final price before trading.',
  style:saved.rateBoardStyle==='cards'?'cards':'table'};
 return {settings,rates:settings.enabled?await publicRates(conn,tenant,now):[]};
}
module.exports={publicRates,publicBoard};
