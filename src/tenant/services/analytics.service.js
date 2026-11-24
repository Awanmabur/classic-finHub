'use strict';
// Read-only operational intelligence. No settlement, profit or PII is inferred.
// Shares audited aggregate adapters with Operations Reports but does not require
// a Reports subscription, role or permission.
const registry=require('../reporting/registry');
const {Types}=require('mongoose');
const {hasModule,hasModuleForUser,hasPermission}=require('./moduleAccess.service');
const {scopeFor}=require('./operationsReports.service');
const {branchMatch}=require('../reporting/aggregateScope');
const models=require('../models');
const {csvCell}=require('./mobileMoney.service');
const {forexCurrencies,currencyLabel}=require('../../config/currencies');
const businessTime=require('../../utils/businessTime');
const PERIODS=Object.freeze([7,14,30]);
const MAX_GROUPS=5000;
const loanModel=kind=>conn=>require('../retailFinance/loans.models').models(conn)[kind];
const airtimeModel=kind=>conn=>require('../retailFinance/airtime.models').models(conn)[kind];
// Match each reporting adapter's event streams and date fields. The daily
// chart reads only the selected source over the two complete local periods.
const activitySources={
  workspace:[{model:models.auditEventModel,branchKey:'metadata.branchId',stringBranch:true}],
  expenses:[{model:require('../models/expenses').expenseModel}],
  mobile_money:[{model:models.mobileTransactionModel}],
  cash_shifts:[{model:models.cashSessionModel}],
  money_transfer:[{model:models.transferOrderModel}],
  banking:[{model:models.bankingRequestModel}],
  forex:[
    {model:models.forexQuoteModel,forexOrigins:true},
    {model:conn=>require('../funded/models').models(conn).execution,dateField:'reviewedAt',
      match:{sourceType:'forex',action:'forex',status:'posted_manual'}}
  ],
  loans:[
    {model:loanModel('loan')},
    {model:loanModel('loan'),dateField:'disbursedAt',match:{status:{$in:['active','paid']}}},
    {model:loanModel('payment')},{model:loanModel('correction')}
  ],
  airtime:[{model:airtimeModel('record')},{model:airtimeModel('correction')}],
  approval_workflows:[{model:models.approvalRequestModel}],
  notifications:[{model:models.notificationMessageModel,stringBranch:true}]
};
function fail(message,status=400){const e=new Error(message);e.status=status;return e;}
function sourcesFor(tenant,user){
  if(!hasModuleForUser(tenant,user,'analytics')||!hasPermission(user,'analytics.view'))return [];
  return registry.filter(a=>Array.isArray(a.moduleKeys)
    ?a.moduleKeys.some(key=>hasModule(tenant,key)&&hasModuleForUser(tenant,user,key))
    :!a.moduleKey||(hasModule(tenant,a.moduleKey)&&hasModuleForUser(tenant,user,a.moduleKey)))
    .map(a=>({key:a.key,label:a.label,moduleKey:a.moduleKey,...(a.moduleKeys?{moduleKeys:a.moduleKeys}:{})}));
}
function filtersFor(query={},sources=[]){
  const raw=String(query.days??'7');
  if(!['7','14','30'].includes(raw))throw fail('Analytics period must be 7, 14 or 30 days');
  const source=String(query.source??'all');
  if(source!=='all'&&!sources.some(s=>s.key===source))throw fail('Analytics source is not available for this account',403);
  return {days:Number(raw),source};
}
function bounds(days,now=new Date(),timeZone='UTC'){
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||!PERIODS.includes(days))throw fail('Invalid analytics period');
  // Compare completed regional days only. Date keys advance by calendar day,
  // not fixed 24-hour UTC intervals, so daylight-saving changes are safe.
  const today=businessTime.localDay(now,timeZone),end=businessTime.startOfDay(today,timeZone);
  const start=businessTime.startOfDay(businessTime.addDays(today,-days),timeZone);
  const previousStart=businessTime.startOfDay(businessTime.addDays(today,-2*days),timeZone);
  return {current:{$gte:start,$lt:end},previous:{$gte:previousStart,$lt:start},start,end,previousStart,timeZone};
}
function countOf(rows){
  if(!Array.isArray(rows)||rows.length>MAX_GROUPS)throw fail('Analytics result is too large. Narrow to one source.',422);
  return rows.reduce((sum,r)=>{
    if(!Number.isSafeInteger(r.count)||r.count<0||sum+r.count>Number.MAX_SAFE_INTEGER)throw fail('Invalid aggregate returned by analytics source',422);
    return sum+r.count;
  },0);
}
function change(current,previous){
  // Avoid meaningless infinity when the previous period had no records.
  if(previous===0)return current===0?'0%':'New activity';
  const ratio=Math.round((current-previous)*1000/previous)/10;
  if(!Number.isFinite(ratio))return 'N/A';
  return `${ratio>0?'+':''}${ratio}%`;
}
async function dailyActivity(conn,source,window,scope,days,forexOrigins){
  const configs=activitySources[source];
  if(!configs)throw fail('Analytics chart source is unavailable',403);
  const timezone=window.timeZone;
  const groups=await Promise.all(configs.map(config=>{
    const dateField=config.dateField||'createdAt',branchKey=config.branchKey||'branchId';
    const branch=branchMatch(scope,config.stringBranch?String:id=>new Types.ObjectId(id));
    const filter={...config.match,[dateField]:{$gte:window.previousStart,$lt:window.end},
      ...(config.forexOrigins?{originModule:{$in:[null,'forex',...forexOrigins]}}:{}),
      ...(branch.branchId?{[branchKey]:branch.branchId}:{})};
    return config.model(conn).aggregate([
      {$match:filter},{$group:{_id:{$dateToString:{format:'%Y-%m-%d',date:'$'+dateField,timezone}},count:{$sum:1}}},
      {$limit:2*days+1}
    ]).option({maxTimeMS:5000});
  }));
  const counts=new Map();
  for(const rows of groups){
    if(rows.length>2*days)throw fail('Too many daily analytics groups',422);
    countOf(rows);
    for(const row of rows){
      const total=(counts.get(row._id)||0)+row.count;
      if(!Number.isSafeInteger(total))throw fail('Invalid daily analytics total',422);
      counts.set(row._id,total);
    }
  }
  const currentStart=businessTime.localDay(window.start,timezone),previousStart=businessTime.localDay(window.previousStart,timezone);
  return Array.from({length:days},(_,index)=>{
    const date=businessTime.addDays(currentStart,index),previousDate=businessTime.addDays(previousStart,index);
    return {date,current:counts.get(date)||0,previousDate,previous:counts.get(previousDate)||0};
  });
}
function chartGroups(rows,keys,format){
  const grouped=new Map();
  for(const row of rows){
    for(const key of new Set(keys(row))){
      grouped.set(key,(grouped.get(key)||0)+row.count);
    }
  }
  return [...grouped].map(([key,count])=>({label:format(key),count})).filter(row=>row.count>0)
    .sort((a,b)=>b.count-a.count||a.label.localeCompare(b.label));
}
function focusSource(data,source){
  if(source!=='all')return data[0];
  const bookkeeping=new Set(['workspace','cash_shifts','notifications','approval_workflows']);
  return data.find(row=>row.current>0&&!bookkeeping.has(row.key))||
    data.find(row=>row.current>0)||data[0];
}
async function generate(conn,tenant,user,query={},now=new Date(),timeZone='UTC',{charts=true}={}){
  const sources=sourcesFor(tenant,user);
  if(!sources.length)throw fail('An active Advanced Analytics entitlement and permission are required',403);
  const filters=filtersFor(query,sources),scope=scopeFor(user),window=bounds(filters.days,now,timeZone);
  const selected=sources.filter(s=>filters.source==='all'||s.key===filters.source);
  const forexOrigins=['mobile_money','banking','money_transfer'].filter(key=>hasModuleForUser(tenant,user,key));
  const data=[],currentRows=new Map();
  // Bounded source count and two bounded aggregate reads per source. Read-only.
  for(const source of selected){
    const adapter=registry.find(a=>a.key===source.key);
    const windows=await Promise.all([window.current,window.previous].map(async dateRange=>{
      const f={from:businessTime.localDay(dateRange.$gte,timeZone),
        to:businessTime.localDay(new Date(dateRange.$lt.getTime()-1),timeZone),
        dateRange,timeZone,source:source.key};
      const rows=await adapter.rows({conn,tenant,user,filters:f,dateRange,scope});
      return source.key==='forex'?rows.filter(row=>!row.source||row.source==='forex'||forexOrigins.includes(row.source)):rows;
    }));
    const current=countOf(windows[0]),previous=countOf(windows[1]);
    if(current===0&&previous===0)continue;
    currentRows.set(source.key,windows[0]);
    const ordered=[...windows[0]].sort((a,b)=>b.count-a.count);
    data.push({key:source.key,label:source.label,current,previous,change:change(current,previous),
      breakdownTruncated:windows[0].length>100,
      breakdown:ordered.slice(0,100).map(r=>({activity:String(r.activity).slice(0,160),status:String(r.status).slice(0,160),currency:String(r.currency).slice(0,16),count:r.count}))});
  }
  const focus=charts?focusSource(data,filters.source):null;
  let trend=null;
  if(focus){
    const rows=currentRows.get(focus.key);
    const isCurrency=code=>Object.hasOwn(forexCurrencies,code);
    trend={
      key:focus.key,days:await dailyActivity(conn,focus.key,window,scope,filters.days,forexOrigins),
      currencies:chartGroups(rows,row=>[row.currency,row.targetCurrency].filter(isCurrency),currencyLabel),
      currencyOverlap:rows.some(row=>isCurrency(row.targetCurrency)&&row.targetCurrency!==row.currency),
      statuses:chartGroups(rows,row=>[String(row.status).slice(0,160)].filter(status=>status!=='—'),status=>status.replaceAll('_',' ')),
      activities:chartGroups(rows,row=>[String(row.activity).slice(0,160)],activity=>activity.replaceAll('_',' '))
    };
  }
  const available=filters.source==='all'?data.map(row=>({key:row.key,label:row.label})):selected;
  return {sources:available,filters,data,timeZone,trend,
    from:businessTime.localDay(window.start,timeZone),to:businessTime.localDay(new Date(window.end.getTime()-1),timeZone),
    previousFrom:businessTime.localDay(window.previousStart,timeZone),previousTo:businessTime.localDay(new Date(window.start.getTime()-1),timeZone),
    note:'Sources count their own records. The same activity can appear in more than one source.'};
}
function csv(report){
  const records=[['Source','Period start ('+(report.timeZone||'UTC')+')','Period end ('+(report.timeZone||'UTC')+')','Current records','Previous records','Change'],
    ...report.data.map(r=>[r.label,report.from,report.to,r.current,r.previous,r.change])];
  return '\uFEFF'+records.map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
// Historical CRUD entrypoints remain deliberately disabled; analytics is read-only.
const unavailable=require('../../utils/unavailableOperation');
module.exports={sourcesFor,filtersFor,bounds,countOf,change,generate,csv,
 list:()=>unavailable('analytics list'),create:()=>unavailable('analytics create'),update:()=>unavailable('analytics update')};
