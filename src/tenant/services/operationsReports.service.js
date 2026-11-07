'use strict';
// Standalone reporting hub. Each operational module registers an adapter here;
// the report engine never grants access to the source module itself.
const mobile=require('./mobileMoney.service');
const {hasPermission,hasModuleForUser,hasModule}=require('./moduleAccess.service');
const MAX_ROWS=5000;
const adapters=require('../reporting/registry');
function fail(message,status=400){const e=new Error(message);e.status=status;return e;}
function scopeFor(user){
  if(['Tenant Owner','Auditor'].includes(user?.role))return require('./branchView.service').readScope(user);
  if(!/^[a-f0-9]{24}$/i.test(String(user?.branchId||'')))throw fail('Active branch assignment is required for reporting',403);
  return {branchId:String(user.branchId)};
}
function sourcesFor(tenant,user){
  if(!hasModuleForUser(tenant,user,'reports')||!hasPermission(user,'reports.view'))return [];
  const sources=adapters.filter(a=>Array.isArray(a.moduleKeys)
    ?a.moduleKeys.some(key=>hasModule(tenant,key)&&hasModuleForUser(tenant,user,key))
    :!a.moduleKey||(hasModule(tenant,a.moduleKey)&&hasModuleForUser(tenant,user,a.moduleKey)))
    .map(a=>({key:a.key,label:a.label,moduleKey:a.moduleKey,...(a.moduleKeys?{moduleKeys:a.moduleKeys}:{})}));
  return sources;
}
function parseFilters(query={},sources=[]){
  const from=String(query.from||''),to=String(query.to||'');
  const dateRange=mobile.dateBounds({from,to});
  const source=String(query.source||'all');
  if(source!=='all'&&!sources.some(s=>s.key===source))throw fail('Report source is not available for this account',403);
  return {from,to,dateRange,source};
}
async function workspaceSource(conn,dateRange,scope){
  return adapters.find(a=>a.key==='workspace').rows({conn,dateRange,scope});
}
function normalizeMobile(summary){return summary.summaries.map(s=>({module:'Mobile Money',activity:`${s._id.network} · ${s._id.operation}`,
  status:`${s._id.status} / ${s._id.reviewState} / ${s._id.correctionState||'none'}`,currency:s._id.currency,count:s.count,volume:s.volumeFormatted,fees:s.feesFormatted}));}
async function generate(conn,tenant,user,query={}){
  const sources=sourcesFor(tenant,user);
  if(!sources.length)throw fail('Operations Reports subscription and reporting permission required',403);
  const filters=parseFilters(query,sources),scope=scopeFor(user);
  const requested=sources.filter(s=>filters.source==='all'||s.key===filters.source);
  let rows=[];
  for(const src of requested){
    const adapter=adapters.find(a=>a.key===src.key);
    if(!adapter)throw fail('Unregistered report source',403);
    rows.push(...await adapter.rows({conn,tenant,user,filters,dateRange:filters.dateRange,scope}));
    if(rows.length>MAX_ROWS)throw fail('Report contains too many groups. Narrow the date range.',422);
  }
  // Workspace audit events, cash-shift records and operational module events
  // can describe the same real-world action. Summing all sources would double
  // count activity and present an invented cross-module KPI.
  const total=requested.length===1?rows.reduce((a,r)=>a+r.count,0):null;
  return {rows,filters,sources,total,
    note:'Each source counts its own operational records. Counts across different sources may overlap and must not be added. No row implies provider settlement or a cleared financial balance.'};
}
function csv(report){
  const records=[['Module','Activity','Status','Currency','Count','Volume (label)','Fees (label)'],
    ...report.rows.map(r=>[r.module,r.activity,r.status,r.currency,r.count,r.volume,r.fees])];
  return '\uFEFF'+records.map(r=>r.map(mobile.csvCell).join(',')).join('\r\n')+'\r\n';
}
module.exports={sourcesFor,parseFilters,scopeFor,workspaceSource,normalizeMobile,generate,csv,MAX_ROWS};
