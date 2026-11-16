'use strict';
// Read-only operational intelligence. No settlement, profit or PII is inferred.
// Shares audited aggregate adapters with Operations Reports but does not require
// a Reports subscription, role or permission.
const registry=require('../reporting/registry');
const {hasModule,hasModuleForUser,hasPermission}=require('./moduleAccess.service');
const {scopeFor}=require('./operationsReports.service');
const {auditEventModel}=require('../models');
const {csvCell}=require('./mobileMoney.service');
const businessTime=require('../../utils/businessTime');
const DAY=86400000;
const PERIODS=Object.freeze([7,14,30]);
const MAX_GROUPS=5000;
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
async function workspaceDaily(conn,range,scope,timeZone='UTC'){
  const filter={createdAt:range};
  if(scope.branchId)filter['metadata.branchId']=String(scope.branchId);
  const entries=await auditEventModel(conn).aggregate([
    {$match:filter},{$group:{_id:{$dateToString:{format:'%Y-%m-%d',date:'$createdAt',timezone:timeZone}},count:{$sum:1}}},
    {$sort:{_id:1}},{$limit:32}
  ]);
  if(entries.length>30)throw fail('Too many daily analytics groups',422);
  const dayCounts=new Map(entries.map(x=>[x._id,x.count]));
  const days=[];
  const begin=businessTime.localDay(range.$gte,timeZone),endDay=businessTime.localDay(range.$lt,timeZone);
  for(let date=begin;date<endDay;date=businessTime.addDays(date,1)){
    const count=dayCounts.get(date)||0;
    if(!Number.isSafeInteger(count)||count<0)throw fail('Invalid workspace trend data',422);
    days.push({date,count});
  }
  return days;
}
async function generate(conn,tenant,user,query={},now=new Date(),timeZone='UTC'){
  const sources=sourcesFor(tenant,user);
  if(!sources.length)throw fail('An active Advanced Analytics entitlement and permission are required',403);
  const filters=filtersFor(query,sources),scope=scopeFor(user),window=bounds(filters.days,now,timeZone);
  const selected=sources.filter(s=>filters.source==='all'||s.key===filters.source);
  const data=[];
  // Bounded source count and two bounded aggregate reads per source. Read-only.
  for(const source of selected){
    const adapter=registry.find(a=>a.key===source.key);
    const windows=await Promise.all([window.current,window.previous].map(async dateRange=>{
      const f={from:businessTime.localDay(dateRange.$gte,timeZone),
        to:businessTime.localDay(new Date(dateRange.$lt.getTime()-1),timeZone),
        dateRange,source:source.key};
      return adapter.rows({conn,tenant,user,filters:f,dateRange,scope});
    }));
    const current=countOf(windows[0]),previous=countOf(windows[1]);
    data.push({key:source.key,label:source.label,current,previous,change:change(current,previous),
      breakdownTruncated:windows[0].length>100,
      breakdown:windows[0].slice(0,100).map(r=>({activity:String(r.activity).slice(0,160),status:String(r.status).slice(0,160),currency:String(r.currency).slice(0,16),count:r.count}))});
  }
  const workspaceTrend=selected.some(s=>s.key==='workspace')?await workspaceDaily(conn,window.current,scope,timeZone):[];
  const maxTrend=Math.max(1,...workspaceTrend.map(d=>d.count));
  return {sources,filters,data,timeZone,workspaceTrend:workspaceTrend.map(d=>({...d,percent:Math.round(d.count*100/maxTrend)})),
    from:businessTime.localDay(window.start,timeZone),to:businessTime.localDay(new Date(window.end.getTime()-1),timeZone),
    previousFrom:businessTime.localDay(window.previousStart,timeZone),previousTo:businessTime.localDay(new Date(window.start.getTime()-1),timeZone),
    note:'Operational record counts only. Workspace audit events may overlap module events. Counts must not be added together; no values represent profit, balances, settled money or provider delivery.'};
}
function csv(report){
  const records=[['Source','Period start ('+(report.timeZone||'UTC')+')','Period end ('+(report.timeZone||'UTC')+')','Current records','Previous records','Change'],
    ...report.data.map(r=>[r.label,report.from,report.to,r.current,r.previous,r.change])];
  return '\uFEFF'+records.map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
// Historical CRUD entrypoints remain deliberately disabled; analytics is read-only.
const unavailable=require('../../utils/unavailableOperation');
module.exports={sourcesFor,filtersFor,bounds,countOf,change,workspaceDaily,generate,csv,
 list:()=>unavailable('analytics list'),create:()=>unavailable('analytics create'),update:()=>unavailable('analytics update')};
