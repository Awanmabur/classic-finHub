'use strict';
// This is a read-only setup and work-queue snapshot. Transaction services still
// check the current operator, ledger integrity, liquidity and independent review.
const core=require('../models');
const {models:fundModels}=require('../treasury/models');
const {hasModuleForUser,hasPermission}=require('../services/moduleAccess.service');
const {permissionsFor,requiresTenantMfa}=require('../../config/roles');
const branchView=require('../services/branchView.service');
const SPECS=Object.freeze({
 mobile_money:{label:'Mobile Money',path:'/tenant/mobile-money',create:'mobile_money.cash_in',review:'mobile_money.review'},
 money_transfer:{label:'Money Transfer',path:'/tenant/money-transfer',create:'money_transfer.create',review:'money_transfer.review'},
 banking:{label:'Banking',path:'/tenant/banking',create:'banking.requests.create',review:'banking.review'},
 forex:{label:'Forex',path:'/tenant/forex',create:'forex.quotes.create',review:'forex.quotes.review'},
 expenses:{label:'Expenses',path:'/tenant/expenses',create:'expenses.create',review:'expenses.review'}
});
const key=value=>String(value||'');
function staffActor(person){return {id:key(person._id),role:person.role,branchId:person.branchId,allowedModules:person.allowedModules||[],permissions:permissionsFor(person.role)};}
function usable(account){return account.status==='active'&&account.openingBalanceMinor!=null&&!!account.openingApprovedAt&&account.reconciliationState==='matched'&&!account.lastObservationStale;}
function permitted(person){return !requiresTenantMfa(person.role)||!!person.mfaEnabledAt;}
function operationBranch(person,allBranches){return person.branchId?key(person.branchId):person.role==='Tenant Owner'&&allBranches.length===1?key(allBranches[0]._id):null;}
function eligible(account,person,tenant){const actor=staffActor(person);return (!account.operatorId||key(account.operatorId)===actor.id)&&(account.moduleKey==='shared'||hasModuleForUser(tenant,actor,account.moduleKey));}
// Match the automatic choice rules: an operator's own accounts take precedence
// over shared accounts, and a sole choice does not need an explicit default.
function defaultIssues(accounts,people,tenant){
 const issues=new Set();
 for(const person of people){
  const choices=accounts.filter(account=>eligible(account,person,tenant));
  const groups=new Map();
  for(const account of choices){const group=[account.kind,account.network||'',account.currency].join(':');if(!groups.has(group))groups.set(group,[]);groups.get(group).push(account);}
  for(const [group,rows] of groups){const own=rows.filter(account=>key(account.operatorId)===key(person._id)),selected=own.length?own:rows.filter(account=>!account.operatorId);if(selected.length>1&&selected.filter(account=>account.selectionKey).length!==1)issues.add(`${key(person._id)}:${group}`);}
 }
 return issues.size;
}
function settlement(account){return ['cash','bank','wallet'].includes(account.kind);}
function fundedPath(module,accounts,rates,branch,customerAccounts=[]){
 const ready=accounts.filter(usable),payments=ready.filter(settlement);
 if(module==='mobile_money')return ready.some(wallet=>wallet.kind==='wallet'&&wallet.currency===branch.currency&&payments.some(payment=>payment.kind!=='wallet'&&payment.currency===wallet.currency));
 if(module==='money_transfer')return ready.some(clearing=>clearing.kind==='transfer_clearing'&&!clearing.operatorId&&clearing.currency===branch.currency&&payments.some(payment=>payment.currency===clearing.currency)&&ready.some(cash=>cash.kind==='cash'&&cash.currency===clearing.currency));
 if(module==='banking')return payments.some(payment=>payment.currency===branch.currency&&customerAccounts.some(account=>key(account.branchId)===key(branch._id)&&account.currency===payment.currency));
 if(module==='forex')return rates.some(rate=>ready.some(stock=>stock.kind==='forex_stock'&&stock.currency===rate.fromCurrency)&&payments.some(payment=>payment.currency===rate.toCurrency));
 return payments.some(payment=>payment.currency===branch.currency);
}
function build({tenant,actor,allBranches,people,accounts=[],shifts=[],rates=[],customerAccounts=[],queueCounts={},queueLinks={},devices=[],now=new Date()}){
 const scope=branchView.canViewBranches(actor)?branchView.readScope(actor):{branchId:actor.branchId};
 const branches=allBranches.filter(branch=>!scope.branchId||key(branch._id)===key(scope.branchId));
 const activeBranchIds=new Set(allBranches.map(branch=>key(branch._id))),branchIds=new Set(branches.map(branch=>key(branch._id)));
 const allView=!scope.branchId;
 const staff=people.filter(person=>allView||branchIds.has(key(person.branchId))||person.role==='Tenant Owner');
 const modules=Object.entries(SPECS).filter(([module])=>hasModuleForUser(tenant,actor,module)&&hasPermission(actor,module+'.view'));
 const fundRows=accounts.filter(account=>branchIds.has(key(account.branchId))&&(account.moduleKey==='shared'||hasModuleForUser(tenant,actor,account.moduleKey)));
 const moduleRows=[];
 const check=(id,label,state,detail,href,action)=>({id,label,state,detail,href,action});
 const checks=[check('branches','Operating branches',branches.length?'ready':'blocked',branches.length?`${branches.length} active ${branches.length===1?'branch':'branches'} in this view.`:'Create an active operating branch before recording transactions.','/tenant/branches','Manage branches')];
 const operators=people.filter(person=>Object.entries(SPECS).some(([module,spec])=>hasModuleForUser(tenant,staffActor(person),module)&&hasPermission(staffActor(person),spec.create)));
 const unassigned=operators.filter(person=>!operationBranch(person,allBranches)||!activeBranchIds.has(operationBranch(person,allBranches)));
 const relevantUnassigned=unassigned.filter(person=>allView||key(person._id)===actor.id||branchIds.has(key(person.branchId)));
 checks.push(check('assignments','Staff operating assignments',relevantUnassigned.length?'blocked':'ready',relevantUnassigned.length?`${relevantUnassigned.length} active operating ${relevantUnassigned.length===1?'account needs':'accounts need'} an active branch assignment.`:'Active operating accounts in this view have a resolvable branch.','/tenant/users','Assign staff'));
 const mfaMissing=staff.filter(person=>requiresTenantMfa(person.role)&&!person.mfaEnabledAt);
 checks.push(check('mfa','Privileged account protection',mfaMissing.length?'blocked':'ready',mfaMissing.length?`${mfaMissing.length} active privileged ${mfaMissing.length===1?'account has':'accounts have'} not enrolled an authenticator.`:'Active privileged accounts in this view have authenticator enrollment.','/tenant/users','Review staff access'));
 if(!modules.length)checks.push(check('modules','Subscribed operations','blocked','No financial operation is currently subscribed and assigned.','/tenant/modules','Review modules'));
 for(const [module,spec] of modules){
  for(const branch of branches){
   const candidates=operators.filter(person=>operationBranch(person,allBranches)===key(branch._id)&&permitted(person)&&hasModuleForUser(tenant,staffActor(person),module)&&hasPermission(staffActor(person),spec.create));
   // An administrator's wildcard permission does not make them a daily teller.
   // Include the owner as an operator when no teller is assigned, or when they
   // have explicitly configured an operating drawer/account in this branch.
   const dedicated=candidates.filter(person=>person.role!=='Tenant Owner');
   const branchPeople=candidates.filter(person=>person.role!=='Tenant Owner'||!dedicated.length||fundRows.some(account=>key(account.branchId)===key(branch._id)&&key(account.operatorId)===key(person._id)));
   const accountAccess=person=>hasModuleForUser(tenant,staffActor(person),'accounts')&&hasPermission(staffActor(person),'accounts.view');
   const reviewers=people.filter(person=>permitted(person)&&(person.role==='Tenant Owner'||key(person.branchId)===key(branch._id))&&hasModuleForUser(tenant,staffActor(person),module)&&hasPermission(staffActor(person),spec.review)&&hasPermission(staffActor(person),'treasury.review')&&(module!=='banking'||accountAccess(person)));
   const independent=branchPeople.filter(person=>reviewers.some(reviewer=>key(reviewer._id)!==key(person._id)));
   const branchAccounts=fundRows.filter(account=>key(account.branchId)===key(branch._id));
   const branchRates=rates.filter(rate=>key(rate.branchId)===key(branch._id)&&rate.status==='active'&&new Date(rate.expiresAt)>now);
   const funded=independent.filter(person=>(module!=='banking'||accountAccess(person))&&reviewers.some(reviewer=>key(reviewer._id)!==key(person._id)&&fundedPath(module,branchAccounts.filter(account=>eligible(account,person,tenant)&&(account.moduleKey==='shared'||hasModuleForUser(tenant,staffActor(reviewer),account.moduleKey))&&(account.kind!=='cash'||(key(account.operatorId)===key(person._id)&&shifts.some(shift=>key(shift.operatorId)===key(person._id)&&key(shift.branchId)===key(branch._id)&&shift.status==='open'&&shift.openingVerifiedAt&&key(shift.treasuryAccountId)===key(account._id))))),branchRates,branch,customerAccounts)));
   const applicable=branchAccounts.filter(account=>module==='mobile_money'?['wallet','cash','bank'].includes(account.kind)&&account.currency===branch.currency:module==='money_transfer'?['cash','bank','wallet','transfer_clearing'].includes(account.kind):module==='forex'?['forex_stock','cash','bank','wallet'].includes(account.kind):settlement(account));
   const ambiguities=defaultIssues(applicable,branchPeople,tenant);
   const problems=[];
   if(!branchPeople.length)problems.push('Assign an active operator with this module and create permission.');
   else if(independent.length<branchPeople.length)problems.push(`${branchPeople.length-independent.length} operator(s) need a different authorized reviewer.`);
   if(module==='forex'&&!branchRates.length)problems.push('Approve an unexpired indicative rate for a stocked currency pair.');
   if(module==='banking'&&!customerAccounts.some(account=>key(account.branchId)===key(branch._id)))problems.push('Create an active internal customer account with a liability ledger mapping. Operator and reviewer both need Customer Accounts access.');
   if(branchPeople.length&&funded.length<branchPeople.length)problems.push(`${branchPeople.length-funded.length} operator(s) lack a reviewed funds path${module==='money_transfer'?' for collection and cash payout with a shared transfer payable':''}. Cash requires their own verified open shift; reviewers need the underlying account modules.`);
   const state=problems.length?'blocked':ambiguities?'attention':'ready';
   if(ambiguities)problems.push(`${ambiguities} account group(s) need a default or an explicit account choice.`);
   const row={key:module,branchId:key(branch._id),label:spec.label,branch:branch.name,path:spec.path,operators:branchPeople.length,preparedOperators:funded.length,reviewers:reviewers.length,state,problems};
   moduleRows.push(row);
  }
 }
 if(modules.length&&branches.length)checks.push(check('funded-operations','Operators, reviewers & funds',moduleRows.some(row=>row.state==='blocked')?'blocked':moduleRows.some(row=>row.state==='attention')?'attention':'ready',`${moduleRows.filter(row=>row.state==='ready').length} of ${moduleRows.length} branch/module setup checks complete. Open the module checklist below for missing prerequisites.`,'/tenant/treasury','Set up funds'));
 const unknown=fundRows.filter(account=>account.openingBalanceMinor==null).length;
 const held=fundRows.filter(account=>account.status==='held'||['mismatch','stale'].includes(account.reconciliationState)||account.lastObservationStale).length;
 const readyFunds=fundRows.filter(usable).length;
 const scopedShifts=shifts.filter(shift=>branchIds.has(key(shift.branchId)));
 const cashPeople=operators.filter(person=>branchIds.has(operationBranch(person,allBranches))&&fundRows.some(account=>account.kind==='cash'&&usable(account)&&key(account.branchId)===operationBranch(person,allBranches)&&eligible(account,person,tenant)));
 const verifiedCashPeople=cashPeople.filter(person=>scopedShifts.some(shift=>key(shift.operatorId)===key(person._id)&&shift.status==='open'&&shift.openingVerifiedAt&&shift.treasuryAccountId&&fundRows.some(account=>key(account._id)===key(shift.treasuryAccountId)&&usable(account))));
 const queues=[];
 const queue=(id,label,count,href,detail)=>queues.push({id,label,count:Number(count||0),href,detail});
 if(modules.length&&hasPermission(actor,'treasury.view')){
  queue('opening','Opening balances awaiting review',queueCounts.opening,'/tenant/treasury/review','Independent approval establishes the opening book balance.');
  queue('observations','Balance observations awaiting review',queueCounts.observations,'/tenant/treasury/review','Review dated statements or physical counts against the book.');
  queue('funding','Funding transfers awaiting review',queueCounts.funding,'/tenant/treasury#funding-history','Approve the recorded transfer between existing accounts.');
  queue('adjustments','Reconciliation adjustments awaiting review',queueCounts.adjustments,'/tenant/treasury/review','Review evidence before changing the funds book.');
  queue('shift-opening','Cash openings awaiting verification',scopedShifts.filter(shift=>shift.status==='pending_open').length,'/tenant/cash/shifts','A different authorized person must verify each opening.');
  queue('shift-closing','Cash closings awaiting review',scopedShifts.filter(shift=>shift.status==='submitted').length,'/tenant/cash/shifts','Review closing counts and the recorded variance.');
  queue('shift-disputed','Disputed cash shifts',scopedShifts.filter(shift=>shift.status==='disputed').length,'/tenant/cash/shifts','Investigate the difference before closing the shift.');
 }
 for(const [module,spec] of modules){
  if(module==='mobile_money'){
   queue('momo','MoMo transactions awaiting review',queueCounts.momo,spec.path,'Review the evidence and network reference.');
   queue('momo-disputed','Disputed MoMo transactions',queueCounts.momoDisputed,spec.path,'Resolve disputed records through their existing review workflow.');
  }else if(['banking','money_transfer','forex'].includes(module))queue(module,`${spec.label} manual movements awaiting review`,queueCounts[module],queueLinks[module]||'/tenant/funded?status=pending_review','Open the oldest pending movement for this module and independently review its evidence.');
  else if(module==='expenses'){
   queue('expenses','Expenses awaiting review',queueCounts.expenses,'/tenant/expenses?status=pending_review','Independently review the pending expense and its payment source.');
   queue('expense-changes','Expense corrections awaiting review',queueCounts.expenseChanges,'/tenant/expenses','Review requested corrections or voids against the original expense.');
  }
  if(module==='forex')queue('fx-rates','Indicative FX rates awaiting review',queueCounts.fxRates,'/tenant/forex/rates','Approval records an internal indicative rate, not a verified market price.');
 }
 const waiting=queues.reduce((sum,row)=>sum+row.count,0),blocked=checks.filter(row=>row.state==='blocked').length;
 const state=blocked?'blocked':held||unknown||waiting||checks.some(row=>row.state==='attention')?'attention':'ready';
 const sms=hasModuleForUser(tenant,actor,'sms_capture')&&hasModuleForUser(tenant,actor,'mobile_money')&&hasPermission(actor,'mobile_money.cash_in')?{active:devices.length,received:devices.filter(device=>device.lastReceivedAt).length,automatic:devices.filter(device=>device.autoRecord).length}:null;
 return {checkedAt:now,scope:allView?'All active branches':branches[0]?.name||'Unavailable branch',state,label:state==='blocked'?'Setup required':state==='attention'?'Attention required':'Setup checks complete',checks,modules:moduleRows,queues,waiting,blockers:blocked,branches:branches.length,staff:staff.length,funds:{total:fundRows.length,ready:readyFunds,unknown,held},cash:{eligible:cashPeople.length,verified:verifiedCashPeople.length,unfinished:scopedShifts.length,open:scopedShifts.filter(shift=>shift.status==='open').length},sms,
  next:checks.find(row=>row.state==='blocked')||((held||unknown)?{href:'/tenant/treasury',action:'Review fund accounts',detail:'Confirm unknown openings and investigate held or stale balances.'}:null)||checks.find(row=>row.state==='attention')||queues.find(row=>row.count)||{href:'/tenant/dashboard',action:'Open dashboard',detail:'Review today’s activity and continue in the subscribed operation.'}};
}
async function snapshot(conn,tenant,actor){
 const trusted=await require('./service').access(conn,tenant,actor);tenant=trusted.tenant;actor=trusted.actor;
 const modules=Object.keys(SPECS).filter(module=>hasModuleForUser(tenant,actor,module)&&hasPermission(actor,module+'.view'));
 const allBranches=await core.branchModel(conn).find({status:'active'}).select('_id name code currency').sort({_id:1}).lean();
 const scope=branchView.canViewBranches(actor)?branchView.readScope(actor):{branchId:actor.branchId};
 if(scope.branchId&&!allBranches.some(branch=>key(branch._id)===key(scope.branchId)))throw Object.assign(new Error('The selected viewing branch is inactive or unavailable.'),{status:403});
 const fundFilter={tenantId:tenant._id,...scope,status:{$ne:'archived'},moduleKey:{$in:['shared',...modules]}};
 const {account,observation,adjustment}=fundModels(conn),canFunds=modules.length&&hasPermission(actor,'treasury.view');
 const directory=require('../customerAccounts/models');
 const [people,accounts,shifts,rates,customerAccounts]=await Promise.all([
  core.tenantUserModel(conn).find({status:'active'}).select('_id role branchId allowedModules mfaEnabledAt').lean(),
  canFunds?account.find(fundFilter).select('_id branchId kind moduleKey network currency operatorId selectionKey status openingBalanceMinor openingApprovedAt reconciliationState lastObservationStale').lean():[],
  canFunds?core.cashSessionModel(conn).find({...scope,status:{$in:['pending_open','open','submitted','disputed']}}).select('branchId operatorId status openingVerifiedAt treasuryAccountId').lean():[],
  modules.includes('forex')?core.forexRateModel(conn).find({...scope,status:'active',expiresAt:{$gt:new Date()}}).select('branchId status fromCurrency toCurrency expiresAt').lean():[],
  modules.includes('banking')&&hasModuleForUser(tenant,actor,'accounts')?directory.accountModel(conn).aggregate([
   {$match:{...scope,status:'active'}},
   {$lookup:{from:directory.customerModel(conn).collection.name,localField:'customerId',foreignField:'_id',as:'customer'}},{$unwind:'$customer'},
   {$match:{'customer.status':'active',$expr:{$eq:['$customer.branchId','$branchId']}}},
   {$lookup:{from:core.ledgerAccountModel(conn).collection.name,localField:'ledgerAccountId',foreignField:'_id',as:'ledger'}},{$unwind:'$ledger'},
   {$match:{'ledger.category':'liability',$expr:{$and:[{$eq:['$ledger.branchId','$branchId']},{$eq:['$ledger.currency','$currency']}]}}},
   {$project:{branchId:1,currency:1}}
  ]):[]
 ]);
 const accountIds=accounts.map(row=>row._id),fundScope={tenantId:tenant._id,...scope,accountId:{$in:accountIds},status:'pending_review'};
 const queueCounts={},queueLinks={};
 const jobs=[];
 const count=(name,query)=>jobs.push(Promise.resolve(query).then(value=>{queueCounts[name]=value;}));
 if(canFunds){
  count('opening',observation.countDocuments({...fundScope,kind:'opening'}));
  count('observations',observation.countDocuments({...fundScope,kind:'checkpoint'}));
  count('adjustments',adjustment.countDocuments(fundScope));
  count('funding',require('../treasury/funding.models').model(conn).countDocuments({tenantId:tenant._id,...scope,status:'pending_review',sourceAccountId:{$in:accountIds},destinationAccountId:{$in:accountIds}}));
 }
 if(modules.includes('mobile_money')){
  count('momo',core.mobileTransactionModel(conn).countDocuments({...scope,reviewState:'awaiting_review',status:{$ne:'voided_internal'}}));
  count('momoDisputed',core.mobileTransactionModel(conn).countDocuments({...scope,reviewState:'disputed',status:{$ne:'voided_internal'}}));
 }
 for(const module of modules.filter(module=>['banking','forex','money_transfer'].includes(module))){
  const Execution=require('../funded/models').models(conn).execution,filter={...scope,sourceType:module,status:'pending_review'};
  count(module,Execution.countDocuments(filter));
  jobs.push(Execution.findOne(filter).sort({createdAt:1,_id:1}).select('_id').lean().then(row=>{if(row)queueLinks[module]='/tenant/funded/'+row._id;}));
 }
 if(modules.includes('forex'))count('fxRates',core.forexRateModel(conn).countDocuments({...scope,status:'pending_review',expiresAt:{$gt:new Date()}}));
 if(modules.includes('expenses')){
  const Expense=require('../models/expenses').expenseModel(conn);
  count('expenses',Expense.countDocuments({...scope,status:'pending_review'}));
  count('expenseChanges',Expense.countDocuments({...scope,correctionState:'requested'}));
 }
 const sms=hasModuleForUser(tenant,actor,'sms_capture')&&hasModuleForUser(tenant,actor,'mobile_money')&&hasPermission(actor,'mobile_money.cash_in');
 const devices=sms?await require('../../platform/models/SmsDevice').find({tenantId:tenant._id,...scope,status:'active'}).select('_id autoRecord lastReceivedAt').lean():[];
 await Promise.all(jobs);
 return build({tenant,actor,allBranches,people,accounts,shifts,rates,customerAccounts,queueCounts,queueLinks,devices});
}
module.exports={snapshot,build,usable,defaultIssues,fundedPath,SPECS};
