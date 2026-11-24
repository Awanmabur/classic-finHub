'use strict';

const {forexRateModel}=require('../models');
const {currencyLabel}=require('../../config/currencies');

function pairFilter(branchId,fromCurrency,toCurrency,side){
 return {branchId,fromCurrency,toCurrency,side,reviewedBy:{$ne:null}};
}

function classify(rates,{now=new Date(),minRemainingMs=0}={}){
 const active=rates.find(rate=>rate.status==='active');
 if(active){
  const remaining=new Date(active.expiresAt).getTime()-now.getTime();
  if(remaining>minRemainingMs)return {status:'active',rate:active};
  if(remaining>0)return {status:'expiring',rate:active};
 }
 const expired=rates.find(rate=>rate.status==='expired')||active;
 return expired?{status:'expired',rate:expired}:{status:'missing'};
}

async function find(conn,{branchId,fromCurrency,toCurrency,side,now,minRemainingMs=0,session=null}){
 const rates=await forexRateModel(conn).find({
  ...pairFilter(branchId,fromCurrency,toCurrency,side),status:{$in:['active','expired']}
 }).sort({status:1,expiresAt:-1,_id:-1}).limit(2).session(session).lean();
 return classify(rates,{now,minRemainingMs});
}

function isIssue(error){
 return /^FX_RATE_(?:MISSING|EXPIRED|EXPIRING|CHANGED)$/.test(error?.code||'');
}

function remaining(rate,direction,now=Date.now()){
 const milliseconds=new Date(rate.expiresAt).getTime()-now;
 if(!(milliseconds>0))throw problem('expired',direction);
 return milliseconds;
}

function problem(status,{fromCurrency,toCurrency,side,minRemainingMs=0,canSetRate=false}){
 const pair=currencyLabel(fromCurrency)+' → '+currencyLabel(toCurrency);
 const label=(side==='buy'?'Buy':side==='sell'?'Sell':'Exchange')+' rate for '+pair;
 const messages={
  missing:'No '+label+' is set for this branch. '+(canSetRate?'Set the rate':'Ask the owner to set it')+' before continuing.',
  expired:'The '+label+' has expired. '+(canSetRate?'Renew the rate':'Ask the owner to renew it')+' before continuing.',
  expiring:'The '+label+' expires too soon'+(minRemainingMs>=60000?' (less than '+Math.ceil(minRemainingMs/60000)+' min remaining)':'')+'. '+(canSetRate?'Renew the rate.':'Ask the owner to renew it.'),
  changed:'The '+label+' changed. Check the current rate and confirm the amounts again.'
 };
 const state=Object.hasOwn(messages,status)?status:'changed';
 return Object.assign(new Error(messages[state]),{status:409,code:'FX_RATE_'+state.toUpperCase()});
}

module.exports={pairFilter,classify,find,problem,isIssue,remaining};
