'use strict';
const {Router}=require('express');
const {randomUUID}=require('node:crypto');
const requirePermission=require('../../middleware/requirePermission');
const throttle=require('../../platform/services/actionThrottle.service').financial;
const {flash}=require('../../utils/view');
const treasury=require('./service');
const funding=require('./funding.service');
const branchView=require('../services/branchView.service');
const {tenantUserModel,cashSessionModel}=require('../models');
const {activeFilter}=require('../services/cashDrawer.service');
const branchService=require('../services/branch.service');
const setup=require('../setup/routes').validation;
const currencyCodes=require('../../config/currencies').currencyCodes;
const networkTariffs=require('../pricing/networkTariffs');
const mobileCorrections=require('./mobileCorrections.routes');
const fundingKinds=['cash','bank','wallet'];
const ownerKinds=['cash','bank','wallet','forex_stock'];
const ownerActions=['add','check','reconcile','edit','activity','deposit','corrections'];
const isOwner=req=>req.user.role==='Tenant Owner';
function ownerTarget(accountId,action=''){
 return '/tenant/treasury?account='+encodeURIComponent(String(accountId))+(action?'&action='+action:'')+'#selected-account';
}
function eligibleFunds(account){
 return fundingKinds.includes(account.kind)&&!account.integrityBlocked&&account.status==='active'&&
  account.openingBalanceMinor!==null&&account.openingApprovedAt&&account.reconciliationState==='matched';
}
module.exports=function treasuryRoutes({renderTenant}){
 const router=Router(),wrap=handler=>(req,res,next)=>Promise.resolve(handler(req,res)).catch(next);
 const ownerWrite=(handler,target)=>wrap(async(req,res)=>{
  try{await handler(req,res);}catch(error){
   if(!isOwner(req)||![400,409,422].includes(error.status))throw error;
   flash(req,'bad',error.message);
   res.redirect(303,target(req));
  }
 });
 const accountTarget=action=>req=>ownerTarget(req.params.id,action);
 router.use(requirePermission('treasury.view'));
 router.use((req,res,next)=>{res.setHeader('Cache-Control','private, no-store');next();});
 router.use(mobileCorrections.router());
 router.use(require('./owner-funding.routes')());
 function can(req,permission){return req.user.permissions.includes('*')||req.user.permissions.includes(permission);}
 function canReviewFunding(req,row){
  return can(req,'treasury.review')&&row.status==='pending_review'&&funding.canReview(row,req.user);
 }
 function canRequestContribution(req,account){
  return can(req,'treasury.observe')&&eligibleFunds(account)&&
   (!account.operatorId||String(account.operatorId)===String(req.user.id)||req.user.role==='Tenant Owner');
 }
 function fundingRedirect(req,row,fallback){
  const [destination,source]=[row.destinationAccountId,row.sourceAccountId].map(id=>id?String(id):'');
  const current=req.body.returnToAccount;
  if(isOwner(req)){
   if(current==='true'||current===destination)return ownerTarget(destination);
   return source&&current===source?ownerTarget(source):fallback;
  }
  const section=row.status==='pending_review'?'#funding-status':'#account-activity';
  if(current==='true'||current===destination)return '/tenant/treasury/accounts/'+destination+section;
  if(source&&current===source)return '/tenant/treasury/accounts/'+source+section;
  return fallback;
 }
 async function ownerWorkspace(req,res,base){
  const {snapshot,viewBranchId,setupBranch,branchNames,mode}=base;
  const accountId=typeof req.query.account==='string'&&/^[a-f0-9]{24}$/.test(req.query.account)?req.query.account:null;
  const action=ownerActions.includes(req.query.action)?req.query.action:'';
  const kinds=setup.accountKinds(req.tenant,req.user);
  const branches=res.locals.viewBranches||[];
  const visible=snapshot.accounts.find(account=>String(account._id)===accountId);
  const archivedAccounts=await treasury.models(req.tenantDb).account.find({
   tenantId:req.tenant._id,status:'archived',kind:{$in:kinds},...(viewBranchId?{branchId:viewBranchId}:{})
  }).select('_id name kind currency code branchId status openingBalanceMinor bookBalanceMinor openingApprovedAt sequence')
   .sort({updatedAt:-1,_id:-1}).limit(50).lean();
  const archived=archivedAccounts.find(account=>String(account._id)===accountId);
  const selected=visible||archived||null;
  const viewDetails=selected&&!selected.integrityBlocked&&(!archived||action==='activity');
  const operatingDrawer=viewDetails&&selected.kind==='cash'&&String(selected.operatorId)===String(req.user.id)&&
   String(selected.branchId)===String(req.operationBranch?._id);
  const accountFilter=selected?{accountId:selected._id}:{};
  const deposits=require('../customerAccounts/deposit');
  const [ownerStaff,openDrawerShift,pendingDeposits,treasuryDeposit,expenseReconciliation,detail,walletDrawers,mobileRecords,pendingFunding]=await Promise.all([
   can(req,'treasury.manage')&&branches.length>0?tenantUserModel(req.tenantDb).find({
    status:'active',role:{$ne:'Tenant Owner'},branchId:{$in:branches.map(branch=>String(branch._id))}
   }).select('name role branchId').sort({name:1}).limit(300).lean():[],
   operatingDrawer?cashSessionModel(req.tenantDb).exists({
    ...activeFilter(selected.branchId,req.user.id,selected.currency),treasuryAccountId:selected._id,status:'open'
   }):null,
   deposits.pendingForOwner(req.tenantDb,req.tenant,req.user,{branchId:viewBranchId,...accountFilter}),
   viewDetails&&action==='deposit'?deposits.treasuryForm(req.tenantDb,req.tenant,req.user,selected):null,
   require('../services/expenses.service').ownerReconciliation(req.tenantDb,req.tenant,req.user,{
    reference:req.query.expenseRef,currency:req.query.currency
   }),
   viewDetails&&(action==='activity'||selected.pendingObservation||selected.reconciliationState==='mismatch')?
    treasury.accountDetail(req.tenantDb,req.tenant,req.user,selected._id):null,
   viewDetails&&action==='edit'&&selected.kind==='wallet'?treasury.models(req.tenantDb).account.find({
    tenantId:req.tenant._id,branchId:selected.branchId,kind:'cash',currency:selected.currency,status:'active',
    reconciliationState:'matched',openingApprovedAt:{$ne:null}
   }).select('_id name operatorId').sort({name:1}).lean():[],
   action==='corrections'?mobileCorrections.list(req):null,
   funding.pendingForOwner(req.tenantDb,req.tenant,req.user,{branchId:viewBranchId,...accountFilter})
  ]);
  const canDeposit=Boolean(hasSource(req,'banking')&&hasSource(req,'accounts')&&visible&&eligibleFunds(visible)&&String(visible.branchId)===String(req.operationBranch?._id)&&
   (!visible.operatorId||String(visible.operatorId)===String(req.user.id)));
  return {
   action,selected,caseMissing:Boolean(accountId&&!selected),archivedAccounts,branches,
   branchNames,setupBranch:setupBranch||branches[0],ownerStaff,detail,walletDrawers,
   cashDayOpen:Boolean(openDrawerShift),pendingDeposits,treasuryDeposit,expenseReconciliation,canDeposit,
   mobileCorrections:mobileRecords,pendingFunding,
   canCorrectMobile:hasSource(req,'mobile_money')&&can(req,'mobile_money.review'),
   reconcileObservation:detail?.ownerReconciliationObservation,
   canReviewBalance:row=>treasury.canReviewBalance(row,selected,req.user),
   canOpenCreation:mode==='create'||(!snapshot.accounts.length&&branches.length>0),
   accountTarget:ownerTarget,
   canRecordCapital:account=>ownerKinds.includes(account.kind)&&
    ((account.status==='active'&&account.reconciliationState==='matched')||
      (account.status==='held'&&account.reconciliationState==='mismatch')),
   canCreateBranch:branches.length===0&&can(req,'branches.manage'),
   kinds,
   currencyCodes,networks:treasury.NETWORKS,networkCurrencies:networkTariffs.NETWORKS,
   timeZones:setup.timeZones,
   openingKey:randomUUID(),capitalKey:randomUUID(),checkKey:randomUUID(),reconcileKey:randomUUID()
  };
 }
 async function renderList(req,res,mode='accounts'){
  const branchId=branchView.canViewBranches(req.user)?(req.viewBranchId==='all'?null:req.viewBranchId):req.operationBranch?String(req.operationBranch._id):null;
  // These are independent reads: avoid blocking each query behind the slowest
  // ledger verification. The integrity hold is still enforced before a
  // funding account is offered in the selector.
  const setupBranch=branchView.canViewBranches(req.user)?req.viewBranch:req.operationBranch;
  const operatorScope=setupBranch?[{branchId:String(setupBranch._id)},...(String(req.operationBranch?._id||'')===String(setupBranch._id)?[{_id:req.user.id}]:[])]:[];
  const reviewing=mode==='review',showHistory=mode==='history';
  const [snapshot,queue,operators,fundings,operatingAccounts]=await Promise.all([
   treasury.balanceSnapshot(req.tenantDb,req.tenant,req.user,{branchId,currency:isOwner(req)?null:req.query.currency||null}),
   reviewing?treasury.reviewQueue(req.tenantDb,req.tenant,req.user):{observations:[],adjustments:[]},
   can(req,'treasury.manage')&&setupBranch?tenantUserModel(req.tenantDb).find({status:'active',$or:operatorScope}).select('name role branchId').sort({name:1}).limit(300).lean():[],
   reviewing||showHistory?funding.list(req.tenantDb,req.tenant,req.user,reviewing?{status:'pending_review'}:{}):[],
   can(req,'treasury.observe')?treasury.findOperatingAccounts(req.tenantDb,req.tenant,req.user,{branchId}):[]
  ]);
  // A ledger integrity hold cannot be bypassed through the funding selector.
  const blocked=new Set(snapshot.accounts.filter(a=>a.integrityBlocked).map(a=>String(a._id)));
  const fundingAccounts=operatingAccounts.filter(account=>!blocked.has(String(account._id))&&canRequestContribution(req,account));
  const kinds=treasury.KINDS.filter(kind=>kind==='wallet'?hasSource(req,'mobile_money'):kind==='forex_stock'?hasSource(req,'forex'):kind==='transfer_clearing'?hasSource(req,'money_transfer'):true);
  const ownerMoney=isOwner(req)?await ownerWorkspace(req,res,{
   snapshot,viewBranchId:branchId,setupBranch,branchNames:Object.fromEntries((res.locals.viewBranches||[]).map(branch=>[String(branch._id),branch.name])),mode
  }):null;
  renderTenant(req,res,'treasury/index',ownerMoney?'Money accounts':'Business funds',
   ownerMoney?'Balances and reconciliation.':'Wallets, drawers and bank balances.',{
   snapshot,queue,operators,setupBranch,mode,allBranches:req.viewBranchId==='all',ownerMoney,
   branchNames:Object.fromEntries((res.locals.viewBranches||[]).map(branch=>[String(branch._id),branch.name])),
   canCreateAccount:can(req,'treasury.manage')&&Boolean(setupBranch),
   fundings:reviewing?fundings.filter(row=>canReviewFunding(req,row)):fundings,fundingAccounts,
   canReviewFunding:row=>canReviewFunding(req,row),canRequestContribution:account=>canRequestContribution(req,account),
   fundingDestination:String(req.query.to||''),currencyCodes,
   canManage:can(req,'treasury.manage'),canObserve:can(req,'treasury.observe'),canReview:can(req,'treasury.review'),
   kinds,networks:treasury.NETWORKS,
   networkMarketCurrencies:Object.fromEntries(Object.entries(require('../pricing/networkTariffs').NETWORKS).map(([key,meta])=>[key,meta.currency||''])),
   format:treasury.format,fundingIdempotencyKey:randomUUID()
  });
 }
 function hasSource(req,key){return require('../services/moduleAccess.service').hasModuleForUser(req.tenant,req.user,key);}
 router.get('/',wrap((req,res)=>renderList(req,res,req.query.view==='history'?'history':req.query.create==='1'?'create':'accounts')));
 router.get('/accounts/new',requirePermission('treasury.manage'),wrap((req,res)=>isOwner(req)?res.redirect(303,'/tenant/treasury?create=1#account-setup'):renderList(req,res,'create')));
 router.get('/review',requirePermission('treasury.review'),wrap((req,res)=>isOwner(req)?res.redirect(303,'/tenant/treasury'):renderList(req,res,'review')));
 router.post('/branch',requirePermission('branches.manage'),throttle,ownerWrite(async(req,res)=>{
  if(!isOwner(req))throw treasury.fail('Only the business owner can set up a branch here',403);
  const branches=await branchService.list(req.tenant);
  if(branches.some(branch=>branch.status==='active'))throw treasury.fail('An operating branch already exists. Use Branches to add another location.',409);
  const created=await branchService.create(req.tenant,req.user,setup.branchInput(req.body));
  branchView.followRecord(req,{branchId:created._id});
  flash(req,'good','Branch created. Add your first account below.');
  res.redirect(303,'/tenant/treasury?create=1#account-setup');
 },()=>'/tenant/treasury#account-setup'));
 router.post('/accounts',requirePermission('treasury.manage'),throttle,ownerWrite(async(req,res)=>{
  // Never trust hidden/legacy fields for internal ledger identity.
  // Only a server-generated account code can be assigned through the UI.
  if(Object.prototype.hasOwnProperty.call(req.body||{},'code'))
   throw treasury.fail('Account codes are generated automatically. Remove the supplied code and retry.',400);
  if(isOwner(req)&&Object.prototype.hasOwnProperty.call(req.body||{},'branchId')){
   const branches=(await branchService.list(req.tenant)).filter(branch=>branch.status==='active');
   const {account:values,branchId}=setup.moneyInput(req.body,req.tenant,req.user,branches);
   const account=await treasury.createAccount(req.tenantDb,req.tenant,req.user,values,{configurationBranchId:branchId});
   branchView.followRecord(req,account);
   flash(req,'good','Account created. Add the actual starting amount below.');
   return res.redirect(303,ownerTarget(account._id,'add'));
  }
  if(branchView.canViewBranches(req.user)&&!req.viewBranch)throw treasury.fail('Choose a branch before adding an account',409);
  const account=await treasury.createAccount(req.tenantDb,req.tenant,req.user,req.body,{configurationBranchId:req.viewBranch?String(req.viewBranch._id):null});flash(req,'good','Account created. Confirm its starting balance to begin transactions.');branchView.followRecord(req,account);res.redirect(303,isOwner(req)?ownerTarget(account._id,'add'):'/tenant/treasury/accounts/'+account._id);
 },()=>'/tenant/treasury?create=1#account-setup'));
 // Existing per-account balance section now handles BOTH owner capital and
 // direct actual checks; no duplicate top-up screen or routine review queue.
 // Old bookmarks and already-open forms must not become 404 after removing
 // the duplicate top-up page. They use the SAME audited owner capital service.
 router.get('/capital',(req,res)=>res.redirect(303,'/tenant/treasury'));
 router.post('/capital',requirePermission('treasury.manage'),throttle,ownerWrite(async(req,res)=>{
  const result=await treasury.addCapital(req.tenantDb,req.tenant,req.user,
   req.body.accountId,{amount:req.body.amount,idempotencyKey:req.body.idempotencyKey});
  flash(req,'good',result.duplicate?
   'Already recorded. No duplicate funds were added.':
   result.holdPreserved?
    'New money recorded in the account. The earlier balance difference remains held; spending is still blocked.':
    'New money recorded. See the updated account balance.');
  branchView.followRecord(req,result.batch);
  res.redirect(303,ownerTarget(result.accountId));
 },req=>ownerTarget(req.body?.accountId||'','add')));
 router.post('/accounts/:id/record',requirePermission('treasury.observe'),throttle,ownerWrite(async(req,res)=>{
  if(req.user.role!=='Tenant Owner')throw treasury.fail('Only the business owner can record money directly',403);
  // Older already-open forms submit "action"; new forms submit
  // "recordAction" to avoid shadowing the DOM form.action property.
  // Reject inconsistent dual values rather than choose one silently.
  if(req.body.recordAction&&req.body.action&&req.body.recordAction!==req.body.action)
   throw treasury.fail('Conflicting account operation. Reload the account page.',400);
  const operation=req.body.recordAction||req.body.action;
  let nextAction='';
  if(operation==='capital'){
   const result=await treasury.addCapital(req.tenantDb,req.tenant,req.user,req.params.id,{
     amount:req.body.amount,idempotencyKey:req.body.idempotencyKey
   });
   flash(req,'good',result.duplicate?'This addition was already saved. No duplicate credit.':result.holdPreserved?
    'New money added to the recorded balance. This account is still held for its earlier discrepancy; spending is not enabled.':
    'Money added. Balance updated.');
   branchView.followRecord(req,result.batch);
  }else if(operation==='check'){
   const result=await treasury.recordOwnerBalanceCheck(req.tenantDb,req.tenant,req.user,req.params.id,{
     actualBalance:req.body.amount,idempotencyKey:req.body.idempotencyKey
   });
   nextAction=result.matched?'':'reconcile';
   flash(req,result.matched?'good':'info',result.duplicate?'This check was already saved.':result.matched?
     'Actual balance matches the account.':'Balance difference found. Confirm the reconciliation below.');
   branchView.followRecord(req,result.observation);
  }else throw treasury.fail('Choose Add new money or Check actual balance',400);
  res.redirect(303,ownerTarget(req.params.id,nextAction));
 },req=>ownerTarget(req.params.id,(req.body?.recordAction||req.body?.action)==='check'?'check':'add')));
 router.post('/accounts/:id/opening',requirePermission('treasury.observe'),throttle,ownerWrite(async(req,res)=>{
  const {ownerPage,...opening}=req.body;
  const result=await treasury.confirmOwnerOpening(req.tenantDb,req.tenant,req.user,req.params.id,opening);
  flash(req,'good',result.duplicate?'Opening already confirmed.':'Starting balance recorded.');
  branchView.followRecord(req,result.observation);
  res.redirect(303,ownerTarget(req.params.id));
 },accountTarget('add')));
 router.post('/accounts/:id/reconcile',requirePermission('treasury.review'),throttle,ownerWrite(async(req,res)=>{
  if(!isOwner(req))throw treasury.fail('Only the business owner can reconcile an account here',403);
  const {observationId,idempotencyKey,reason}=req.body;
  const result=await treasury.reconcileOwnerBalance(req.tenantDb,req.tenant,req.user,req.params.id,{observationId,idempotencyKey,reason});
  const ready=result.account.status==='active'&&result.account.reconciliationState==='matched';
  flash(req,'good',result.duplicate?'This difference was already reconciled.':
   ready?'Balance reconciled.':'Balance reconciled. The account remains on hold.');
  branchView.followRecord(req,result.account);
  res.redirect(303,ownerTarget(result.account._id));
 },accountTarget('reconcile')));
 router.post('/funding',requirePermission('treasury.observe'),throttle,ownerWrite(async(req,res)=>{
  const sourceKind=req.body.sourceKind??'account_transfer';
  if(!['account_transfer','owner_contribution'].includes(sourceKind))throw treasury.fail('Choose where the money came from',400);
  const contribution=sourceKind==='owner_contribution';
  const action=contribution?funding.request:funding.postDirect;
  const result=await action(req.tenantDb,req.tenant,req.user,req.body);
  flash(req,'good',result.duplicate?'This request was already recorded.':contribution?
   'Contribution sent for approval. The balance updates when approved.':'Funds transferred. Both balances are updated.');
  branchView.followRecord(req,result.funding);
  const fallback=isOwner(req)&&contribution?'/tenant/treasury#pending-funding':'/tenant/treasury?view=history#funding-history';
  res.redirect(303,fundingRedirect(req,result.funding,fallback));
 },()=>'/tenant/treasury#add-funds'));
 router.post('/funding/:id/review',requirePermission('treasury.review'),throttle,wrap(async(req,res)=>{
  const result=await funding.review(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
  flash(req,'good',result.funding.status==='posted'?'Money posted. The balance is up to date.':'Request rejected.');
  branchView.followRecord(req,result.funding);
  res.redirect(303,fundingRedirect(req,result.funding,isOwner(req)?'/tenant/treasury#pending-funding':'/tenant/treasury/review#money-review'));
 }));
 router.get('/accounts/:id',wrap(async(req,res)=>{
  if(isOwner(req)){
   const action=req.query.action==='money'?'add':req.query.action;
   return res.redirect(303,ownerTarget(req.params.id,ownerActions.includes(action)?action:''));
  }
  const detail=await treasury.accountDetail(req.tenantDb,req.tenant,req.user,req.params.id);
  const [cashDrawerOptions,fundings]=await Promise.all([
   detail.account.kind==='wallet'&&can(req,'treasury.manage')?require('../treasury/models').models(req.tenantDb).account.find({
    tenantId:req.tenant._id,branchId:detail.account.branchId,kind:'cash',
    currency:detail.account.currency,status:'active',reconciliationState:'matched',
    openingApprovedAt:{$ne:null}
   }).select('_id name operatorId').sort({name:1}).lean():[],
   fundingKinds.includes(detail.account.kind)?funding.list(req.tenantDb,req.tenant,req.user,{accountId:detail.account._id}):[]
  ]);
  renderTenant(req,res,'treasury/detail',detail.account.name,'',{
   ...detail,cashDrawerOptions,fundings,action:req.query.action,
   canReviewFunding:row=>canReviewFunding(req,row),canRequestContribution:canRequestContribution(req,detail.account),
   canReviewBalance:row=>can(req,'treasury.review')&&treasury.canReviewBalance(row,detail.account,req.user),
   canReviewAdjustment:row=>can(req,'treasury.review')&&treasury.canReviewAdjustment(row,detail.account,req.user),
   canManage:can(req,'treasury.manage'),canObserve:can(req,'treasury.observe'),canReview:can(req,'treasury.review'),
   idempotencyKey:randomUUID(),contributionIdempotencyKey:randomUUID()
  });
 }));
 router.post('/accounts/:id/archive',requirePermission('treasury.manage'),throttle,ownerWrite(async(req,res)=>{
  const account=await treasury.archiveUnusedAccount(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
  flash(req,'good','Unused '+account.kind.replaceAll('_',' ')+' hidden from setup. You can restore it below; its audit history was preserved.');
  res.redirect(303,'/tenant/treasury#archived-accounts');
 },accountTarget('edit')));
 router.post('/accounts/:id/close',requirePermission('treasury.manage'),throttle,ownerWrite(async(req,res)=>{
  const account=await treasury.closeSettledAccount(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
  flash(req,'good','Account closed and hidden from new transactions. All historical postings, receipts and audit records remain intact.');
  branchView.followRecord(req,account);
  res.redirect(303,ownerTarget(account._id,'activity'));
 },accountTarget('edit')));
 router.post('/accounts/:id/restore',requirePermission('treasury.manage'),throttle,ownerWrite(async(req,res)=>{
  const account=await treasury.restoreArchivedAccount(req.tenantDb,req.tenant,req.user,req.params.id);
  flash(req,'good','Account restored. Confirm its real opening balance before using it.');
  branchView.followRecord(req,account);res.redirect(303,ownerTarget(account._id,'add'));
 },()=>'/tenant/treasury#archived-accounts'));
 router.post('/accounts/:id/settings',requirePermission('treasury.manage'),throttle,ownerWrite(async(req,res)=>{
  const account=await treasury.configureAccount(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
  flash(req,'good','Account details saved.');
  branchView.followRecord(req,account);
  res.redirect(303,isOwner(req)?ownerTarget(account._id):`/tenant/treasury/accounts/${req.params.id}`);
 },accountTarget('edit')));
 router.post('/accounts/:id/observations',requirePermission('treasury.observe'),throttle,wrap(async(req,res)=>{
  const input={...req.body};if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(input.observedAt||''))input.observedAt+='Z';
  const result=await treasury.requestObservation(req.tenantDb,req.tenant,req.user,req.params.id,input);flash(req,'good','Dated actual balance evidence saved for review. The expected book was not overwritten.');branchView.followRecord(req,result.observation);res.redirect(303,`/tenant/treasury/accounts/${req.params.id}`);
 }));
 router.post('/observations/:id/review',requirePermission('treasury.review'),throttle,ownerWrite(async(req,res)=>{
  const observation=await treasury.reviewObservation(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
  flash(req,'good',observation.status==='approved'?'Balance evidence recorded.':'Balance evidence rejected.');
  branchView.followRecord(req,observation);
  res.redirect(303,isOwner(req)?ownerTarget(observation.accountId):`/tenant/treasury/accounts/${observation.accountId}`);
 },()=>'/tenant/treasury#accounts'));
 router.post('/observations/:id/adjustments',requirePermission('treasury.observe'),throttle,wrap(async(req,res)=>{const result=await treasury.requestAdjustment(req.tenantDb,req.tenant,req.user,req.params.id,req.body);flash(req,'good','Explicit reconciliation adjustment requested. A different authorized reviewer must decide.');branchView.followRecord(req,result.adjustment);res.redirect(303,`/tenant/treasury/accounts/${result.adjustment.accountId}`);}));
 router.post('/adjustments/:id/review',requirePermission('treasury.review'),throttle,wrap(async(req,res)=>{const result=await treasury.reviewAdjustment(req.tenantDb,req.tenant,req.user,req.params.id,req.body);flash(req,'good','Reconciliation adjustment decision saved with its balanced journal and audit history.');branchView.followRecord(req,result);res.redirect(303,`/tenant/treasury/accounts/${result.accountId}`);}));
 return router;
};
