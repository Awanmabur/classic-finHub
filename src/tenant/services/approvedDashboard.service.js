'use strict';
// The approved root index.html is the single source of truth for the dashboard's
// markup and exact UI wording. Do not fork or rewrite its sections here.
const fs = require('node:fs');
const path = require('node:path');
const {hasPermission,hasModuleForUser} = require('./moduleAccess.service');
const approvedPath = path.resolve(__dirname,'../../../index.html');
const source = fs.readFileSync(approvedPath,'utf8');
const headStart = source.indexOf('<head>');
const headEnd = source.indexOf('</head>');
const mainStart = source.indexOf('<div class="grain"',headEnd);
const mainEnd = source.indexOf('</main>',mainStart);
if(headStart<0||headEnd<0||mainStart<0||mainEnd<0||!source.includes('id="view-reports"'))
  throw new Error('Approved index.html dashboard anchors have changed: review before deployment');
const originalCss = (source.slice(headStart,headEnd).match(/<style\b[^>]*>[\s\S]*?<\/style>/gi)||[]).join('\n')
  // The relative URL resolves to /tenant/images in the authenticated route.
  .replace(/url\((["']?)images\/classicfinhub-logo\.png\1\)/g,'url("/images/classicfinhub-logo.png")');
const originalMain = source.slice(mainStart,mainEnd+'</main>'.length);
const html = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const validId = value => /^[a-f0-9]{24}$/i.test(String(value||''));
function markup(user,branchName='—'){
  let body=originalMain;
  // Only replace hard-coded demo identity and state, not approved structure or wording.
  body=body.replace(/(<span id="sideOperator">)[\s\S]*?(<\/span>)/,(_,a,b)=>a+html(user?.name||'Account')+b);
  body=body.replace(/(<span id="sideBranch">)[\s\S]*?(<\/span>)/,(_,a,b)=>a+html(branchName)+b);
  body=body.replace('id="openBadge">OPEN','id="openBadge">—');
  body=body.replace(/(<em class="tag" style="background:rgba\(91,92,245,\.12\)">)[\s\S]*?(<\/em>)/,(_,a,b)=>a+html(user?.role||'Operator')+b);
  // Empty, unverified prototype counters must not be reported as real financial totals.
  for(const id of ['trCount','trPending','mmCount','bkCount','fxCount','acctCount','customerCount','customerAccountCount','customerTxnCount','accountsTotal','accountsDepositTotal','accountsWithdrawTotal']){
    body=body.replace(new RegExp('(<[^>]+id="'+id+'">)0(</[^>]+>)'),'$1—$2');
  }
  // Original prototype executes these via inline handler. The authenticated
  // dashboard has a strict external-JS CSP and no simulated payment handlers.
  body=body.replace(/\s+onclick="window\.print\(\)"/g,' data-approved-print="true"');
  // The original wrapper ends after main. Keep its exact nested structure.
  return body+'\n</div></div>';
}
function permissions(tenant,user){
  const allow=(module,key)=>hasModuleForUser(tenant,user,module)&&hasPermission(user,key);
  return {
    transferView:allow('money_transfer','money_transfer.view'),
    transferCreate:allow('money_transfer','money_transfer.create'),
    transferContacts:allow('money_transfer','money_transfer.contacts'),
    mobileView:allow('mobile_money','mobile_money.view'),
    mobileCashIn:allow('mobile_money','mobile_money.cash_in'),
    mobileCashOut:allow('mobile_money','mobile_money.cash_out'),
    mobileShift:allow('mobile_money','mobile_money.view')&&['Tenant Owner','Mobile Money Operator'].includes(user.role),
    bankingView:allow('banking','banking.view'),
    bankingCreate:allow('banking','banking.requests.create'),
    bankingAccounts:allow('banking','banking.accounts.manage'),
    forexView:allow('forex','forex.view'),
    forexQuote:allow('forex','forex.quotes.create'),
    forexRate:allow('forex','forex.rate_manage'),
    reportsView:allow('reports','reports.view'),
    reportsExport:allow('reports','reports.export'),
    branchView:hasPermission(user,'branches.view'),
    lastAckView:allow('mobile_money','mobile_money.view')||allow('money_transfer','money_transfer.view')
  };
}
function str(value){return value==null?'':String(value);}
function safeDate(value){const n=new Date(value||0);return Number.isFinite(n.getTime())&&n.getTime()>0?n.toISOString():'';}
function recentProjection(data){
  const items=(list,max=15)=>Array.isArray(list)?list.slice(0,max):[];
  const transfers=items(data.transferRecords?.items).filter(x=>validId(x._id)).map(x=>({
    id:str(x._id),date:safeDate(x.createdAt),sender:str(x.sender?.name),receiver:str(x.beneficiary?.name),
    amountMinor:str(x.amountMinor),feeMinor:str(x.feeMinor),currency:str(x.currency),status:str(x.status),
    reference:str(x.reference),branch:str(x.branchId)
  }));
  const mobile=items(data.summary?.recent).filter(x=>validId(x._id)).map(x=>({
    id:str(x._id),date:safeDate(x.createdAt),customer:str(x.customer),network:str(x.network),
    operation:str(x.operation),amountMinor:str(x.amountMinor),currency:str(x.currency),status:str(x.status),
    reference:str(x.networkReference)
  }));
  const bank=items(data.bankingRecords?.items).filter(x=>validId(x._id)).map(x=>({
    id:str(x._id),date:safeDate(x.createdAt),reference:str(x.reference),status:str(x.status),
    kind:str(x.kind),currency:str(x.currency),amountMinor:str(x.amountMinor)
  }));
  const forex=items(data.forexRecords?.items).filter(x=>validId(x._id)).map(x=>({
    id:str(x._id),date:safeDate(x.createdAt),reference:str(x.reference),status:str(x.status),
    fromCurrency:str(x.fromCurrency),toCurrency:str(x.toCurrency),sourceMinor:str(x.sourceMinor)
  }));
  return {transfers,mobile,bank,forex,mobileTodayTotal:Number.isSafeInteger(data.summary?.total)?data.summary.total:null,
    latestAcknowledgement:data.latestAcknowledgement||null};
}
function safeJson(value){
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,ch=>({
    '<':'\\u003c','>':'\\u003e','&':'\\u0026','\u2028':'\\u2028','\u2029':'\\u2029'
  }[ch]));
}
module.exports={approvedPath,originalCss,originalMain,markup,permissions,recentProjection,safeJson};
