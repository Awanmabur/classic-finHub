const router = require('express').Router();
const { randomUUID } = require('crypto');
const { tenantMenu,tenantNavigationPath } = require('../../services/menu.service');
const { consumeFlash, flash, money, formatUtcDate } = require('../../utils/view');
const requirePermission = require('../../middleware/requirePermission');
const requireModule = require('../../middleware/requireModule');
const mobile = require('../services/mobileMoney.service');
const {modules}=require('../../data/store');
const {planForTenant,effectiveSubscription}=require('../../platform/services/commercial.service');
const UsageCounter=require('../../platform/models/UsageCounter');
const { hasPermission,hasModuleForUser } = require('../services/moduleAccess.service');
const branchService=require('../services/branch.service');
const phoneCountry=require('../../utils/phoneCountry');
const businessTime=require('../../utils/businessTime');
const reportTimeZone=require('../services/reportTimeZone.service');
const staffService=require('../services/staff.service');
const staffPolicy=require('../services/staffPolicy');
router.use(require('./offline.routes'));
router.get('/workspace/theme.css',require('../workspace/routes').theme);
router.use(require('./operationForm.routes'));
router.use(async(req,res,next)=>{try{
 await Promise.all([
  new Promise((resolve,reject)=>require('../services/transactionBranch.service').requestContext(req,res,error=>error?reject(error):resolve())),
  require('../workspace/service').receiptIdentity(req.tenantDb,req.tenant).then(identity=>{req.workspaceIdentity=identity;})
 ]);
 next();
}catch(error){next(error);}});
router.use(require('../../middleware/requireOfflineContext'));
router.use((req,res,next)=>{
 const phone=phoneCountry;
 res.locals.phoneDefaults=phone.defaults(req);
 if(req.method==='POST'){
  const momoCashTransaction=/^\/mobile-money\/(?:cash-in|cash-out)\/?$/.test(req.path);
  for(const field of ['phone','senderPhone','receiverPhone','customerPhone','supportPhone','nextOfKinPhone','legacyReceiverPhone']){
   if(typeof req.body?.[field]!=='string'||!req.body[field])continue;
   let country=field==='senderPhone'&&req.body.senderCountry?req.body.senderCountry:
    field==='receiverPhone'&&req.body.receiverCountry?req.body.receiverCountry:
    req.get('x-classicfin-phone-country')||res.locals.phoneDefaults.country;
   if(momoCashTransaction&&field==='customerPhone')
    country=phone.mobileMoneyCountry(req.body.network,req.body.currency,country);
   req.body[field]=phone.normalize(req.body[field],country);
  }
 }
 next();
});
router.post('/view-branch',require('../services/branchView.service').change);
// Only owners and auditors have tenant-wide visibility. Other users are branch scoped;
// legacy unassigned users have no implicit access to other branches.
function recordScope(req){
  if(['Tenant Owner','Auditor'].includes(req.user.role))return require('../services/branchView.service').readScope(req.user);
  if(req.user.branchId)return {...(req.user.role==='Mobile Money Operator'?{operatorId:req.user.id}:{}),branchId:req.user.branchId};
  return {operatorId:req.user.id};
}

function renderTenant(req, res, view, pageTitle, pageSub, data) {
  res.render('layouts/dashboard', {
    context:'tenant', offlineIdentity:require('../services/offlineIdentity')(req), offlineContext:require('../services/offlineIdentity').context(req,res.locals.phoneDefaults), offlineCacheable:req.method==='GET', currentPath:tenantNavigationPath(req.baseUrl + req.path), pageTitle, pageSub,
    tenant:{...req.tenant,name:req.workspaceIdentity?.name||req.tenant.name,
      brandPrimary:req.workspaceIdentity?.primary,brandSecondary:req.workspaceIdentity?.secondary,
      websiteHref:req.workspaceIdentity?.websiteHref||'/'},
     user:req.user, menu:tenantMenu(req.tenant,req.user),
    view:`../tenant/${view}`, data, flash:consumeFlash(req), money, formatUtcDate,
    businessTimeZone:businessTime.forBranch(req.viewBranch||req.operationBranch),
    businessToday:businessTime.localDay(new Date(),businessTime.forBranch(req.viewBranch||req.operationBranch)),
    businessTimeZoneForBranch:businessTime.forBranch,
    formatLocalDate:(value,branchId)=>{
      const branch=branchId&&(res.locals.viewBranches||[]).find(b=>String(b._id)===String(branchId));
      return businessTime.format(value,businessTime.forBranch(branch||req.viewBranch||req.operationBranch));
    },
    amountFromMinor:mobile.fromMinor
  });
}
router.use('/setup',require('../setup/routes')({renderTenant}));
router.use('/backups',require('../backups/routes')({renderTenant}));
router.use('/treasury',require('../treasury/routes')({renderTenant}));
router.use('/funded',require('./fundedOperations.routes')({renderTenant}));
router.use(require('./cashControl.routes')({renderTenant}));
router.use(require('./dayControl.routes')({renderTenant,recordScope}));
router.use('/mobile-money',require('./mobileMoneyWorkspace.routes')({renderTenant}));
router.use('/mobile-money/tariffs',require('./mobileMoneyTariffs.routes')({renderTenant}));
router.use(require('../customerAccounts/routes')({renderTenant}));
router.use('/workspace',require('../workspace/routes')({renderTenant}));
router.use(require('../retailFinance/routes')({renderTenant}));
router.use(require('./expenses.routes')({renderTenant}));
router.use(require('./approvedReports.routes')({renderTenant}));
router.get('/', (req,res)=>res.redirect(303,'/tenant/dashboard'));
router.get('/dashboard', requirePermission('dashboard.view'), async (req,res,next)=>{
  try {
    // Indexes are prepared by provisioning and awaited by mutation services.
    // Reading an overview must not start collection/index DDL after a restart.
    const overview=await require('../services/dashboardOverview.service').overview(req.tenantDb,req.tenant,req.user,{operationBranch:req.operationBranch,currency:req.query.currency,viewBranch:req.viewBranch,viewBranchId:req.viewBranchId,viewBranches:res.locals.viewBranches});
    renderTenant(req,res,'dashboard/index','Overview','Money transfer, mobile money, banking, forex, tenants, roles, reports, analytics, and daily controls.',overview);
  } catch(e) { next(e); }
});
router.get('/mobile-money', requireModule('mobile_money'), requirePermission('mobile_money.view'), async (req,res,next)=>{
  try {
    const reportZone=await reportTimeZone.forRequest(req);
    const canReview=hasPermission(req.user,'mobile_money.review')&&(req.user.role==='Tenant Owner'||req.user.branchId);
    const reviewBranch=req.user.role==='Tenant Owner'?(require('../services/branchView.service').readScope(req.user).branchId||null):req.user.branchId;
    const [summary,branches,voidQueue,funds,pricingContext]=await Promise.all([
      mobile.getSummary(req.tenantDb,{...recordScope(req),timeZone:reportZone}),
      branchService.list(req.tenant),
      canReview?mobile.getVoidQueue(req.tenantDb,req.user.id,25,reviewBranch):[],
      req.operationBranch?require('../services/mobileMoneyFunds.service').context(req.tenantDb,req.tenant,req.user,req.operationBranch):null,
      require('../pricing/presentation').context(req.tenantDb,req.tenant,req.operationBranch,'mobile_money')
    ]);
    renderTenant(req,res,'mobile-money/index','Mobile Money','Record agent transactions. Provider settlement remains unverified until reconciled.',{
      financeOverview:await require('../services/financeOverview.service').moduleOverview(req.tenantDb,req.tenant,req.user,req.operationBranch),
     entryCurrency:req.operationBranch?require('../services/branchCurrency.service').resolve(req.operationBranch,req.query.currency):null,
      entryCurrencies:req.operationBranch?require('../services/branchCurrency.service').options(req.operationBranch):[],
      summary,branches:branches.filter(b=>b.status==='active' && (req.user.role==='Tenant Owner' || String(b._id)===String(req.user.branchId))),voidQueue,funds,pricingContext,
      canReview: hasPermission(req.user,'mobile_money.review'), idempotencyKey:randomUUID(),
      canRecord: hasPermission(req.user,'mobile_money.cash_in') || hasPermission(req.user,'mobile_money.cash_out')
    });
  } catch(e) { next(e); }
});
for (const [path,op,permission] of [['cash-in','cash_in','mobile_money.cash_in'],['cash-out','cash_out','mobile_money.cash_out']]) {
  router.post(`/mobile-money/${path}`, requireModule('mobile_money'),requirePermission(permission),require('../../platform/services/actionThrottle.service').financial,async(req,res,next)=>{
    try {
      // ONE cash-in/cash-out endpoint: the actual wallet/drawer currency pair
      // determines whether a normal MoMo or linked Forex posting is required.
      // The client never chooses an accounting module or authorizes a rate.
      const T=require('../treasury/models').models(req.tenantDb).account;
      const OID=/^[a-f0-9]{24}$/i;
      const walletId=String(req.body.walletAccountId||''),cashId=String(req.body.paymentAccountId||'');
      if(!OID.test(walletId)||!OID.test(cashId)||!req.operationBranch){
        const error=new Error('Select your actual provider wallet and cash drawer');error.status=400;throw error;
      }
      const pair=await T.find({_id:{$in:[walletId,cashId]},tenantId:req.tenant._id,
       branchId:req.operationBranch._id,status:'active',reconciliationState:'matched',
       openingApprovedAt:{$ne:null}}).lean();
      const wallet=pair.find(a=>String(a._id)===walletId&&a.kind==='wallet');
      const cash=pair.find(a=>String(a._id)===cashId&&a.kind==='cash');
      if(!wallet||!cash||wallet.network!==String(req.body.network||'')||
        wallet.currency!==String(req.body.currency||'')){
       const error=new Error('Wallet, provider network or cash account changed. Reload and select the actual accounts.');
       error.status=409;throw error;
      }
      if(wallet.currency===cash.currency){
       const result=await mobile.recordMobileMoney(req.tenantDb,req.user,req.body,op,req.tenant,null,{requireFunds:true});
       flash(req,'good',result.duplicate?'Already recorded. No duplicate cash or float movement.':
        (op==='cash_in'?'Deposit':'Withdrawal')+' recorded. TX ID: '+result.created.networkReference);
       require('../services/branchView.service').followRecord(req,result.created);
      }else{
       // Fee and conversion must be the exact same terms the cashier previewed.
       // In particular, no client may silently post an extra fee outside the
       // owner-controlled cross-currency quote.
       if(!/^0+(?:\.0+)?$/.test(String(req.body.fee??'0').trim())){
        const error=new Error('Cross-currency amount includes the owner-approved rate only. Clear the separate fee and recheck the displayed cash amount.');
        error.status=409;throw error;
       }
       const direction=op==='cash_out'?'withdraw_provider_receive_cash':'deposit_cash_send_provider';
       const serverQuote=await require('../services/momoFxPreview.service').preview(
        req.tenantDb,req.tenant,req.user,req.operationBranch,{
         operation:direction,walletAccountId:walletId,cashAccountId:cashId,
         ...(op==='cash_in'?{cashAmount:String(req.body.amount||'')}:{providerAmount:String(req.body.amount||'')})
        });
       if(String(req.body.fxRateId||'')!==serverQuote.rateId||
         String(req.body.fxRateVersion||'')!==String(serverQuote.rateVersion)||
         String(req.body.fxCashAmountMinor||'')!==serverQuote.cashAmountMinor||
         String(req.body.fxProviderAmountMinor||'')!==serverQuote.providerAmountMinor){
         const error=new Error('Exchange quote changed. Recalculate and confirm the actual cash amount before finalizing.');
         error.status=409;throw error;
       }
       // No second provider payment, standalone Forex subscription, or second
       // ledger operation is created. Both module views reference one source.
       const result=await require('../services/momoFxSettlement.service').settleManuallyConfirmed(
         req.tenantDb,req.tenant,req.user,{
          ...serverQuote,idempotencyKey:req.body.idempotencyKey,branchId:String(req.operationBranch._id),
          customer:req.body.customer,
          customerPhone:req.body.customerPhone,customerNote:req.body.customerNote,
          transactionConfirmed:'yes' // Authenticated POST is the final Record acknowledgement
         });
       flash(req,'good',result.duplicate?'Already recorded. No duplicate cash or float movement.':
        (op==='cash_in'?'Deposit':'Withdrawal')+' recorded with Forex. TX ID: '+(result.mobile?.networkReference||result.record.providerReference));
       if(result.mobile)require('../services/branchView.service').followRecord(req,result.mobile);
      }
      res.redirect(303,'/tenant/mobile-money');
    } catch(e) { next(e); }
  });
}
router.post('/mobile-money/:id/request-void',requireModule('mobile_money'),requirePermission('mobile_money.view'),
  require('../../platform/services/actionThrottle.service').financial,async(req,res,next)=>{
  try{
    await mobile.requestVoid(req.tenantDb,req.user,req.params.id,req.body.note);
    flash(req,'good','Correction requested. The original record is preserved until a different authorized reviewer decides.');
    res.redirect(303,'/tenant/mobile-money');
  }catch(e){next(e);}
});
router.post('/mobile-money/:id/decide-void',requireModule('mobile_money'),requirePermission('mobile_money.review'),
  require('../../platform/services/actionThrottle.service').financial,async(req,res,next)=>{
  try{
    await mobile.decideVoid(req.tenantDb,req.user,req.params.id,req.body.decision,req.body.note);
    flash(req,'good','Correction decision recorded with an audit event. Provider or ledger status was not changed.');
    res.redirect(303,'/tenant/mobile-money');
  }catch(e){next(e);}
});
router.get('/mobile-money/alerts',requireModule('mobile_money'),requirePermission('mobile_money.view'),async(req,res,next)=>{
  try{
    if(req.user.role!=='Tenant Owner'){const e=new Error('Owner permission required');e.status=403;throw e;}
    const alerts=await require('../models').notificationMessageModel(req.tenantDb)
      .find({recipientId:req.user.id,source:'risk_alert'}).select('_id branchId subject body sourceId createdAt readAt emailState')
      .sort({createdAt:-1,_id:-1}).limit(100).lean();
    renderTenant(req,res,'mobile-money/alerts','Transaction Alerts','Owner-only anomaly signals. No transaction approval required.',{alerts});
  }catch(e){next(e);}
});
router.post('/mobile-money/alerts/:id/read',requireModule('mobile_money'),requirePermission('mobile_money.view'),require('../../platform/services/actionThrottle.service').financial,async(req,res,next)=>{
  try{
    if(req.user.role!=='Tenant Owner'){const e=new Error('Owner permission required');e.status=403;throw e;}
    if(!/^[a-f0-9]{24}$/i.test(req.params.id)){const e=new Error('Invalid alert identifier');e.status=400;throw e;}
    await require('../models').notificationMessageModel(req.tenantDb).updateOne({_id:req.params.id,recipientId:req.user.id,source:'risk_alert',readAt:null},{$set:{readAt:new Date()}});
    res.redirect(303,'/tenant/mobile-money/alerts');
  }catch(e){next(e);}
});
// Physical cash count shifts are internal operational evidence, not provider float.
const cash=require('../services/cashDrawer.service');
const financialThrottle=require('../../platform/services/actionThrottle.service').financial;
// Keep one operating cash control page across Mobile Money and other modules.
router.get('/mobile-money/shifts',requireModule('mobile_money'),requirePermission('mobile_money.view'),(req,res)=>{
 const cursor=typeof req.query.cursor==='string'&&req.query.cursor.length<=200?'?cursor='+encodeURIComponent(req.query.cursor):'';
 res.redirect(303,'/tenant/cash/shifts'+cursor);
});
router.post('/mobile-money/shifts/open',requireModule('mobile_money'),requirePermission('mobile_money.view'),financialThrottle,async(req,res,next)=>{
  try{const shift=await cash.open(req.tenantDb,req.tenant,req.user,req.body);
    flash(req,'good','Opening cash count submitted. A different authorized supervisor must approve it before you can record operations.');require('../services/branchView.service').followRecord(req,shift);res.redirect(303,'/tenant/mobile-money/shifts');
  }catch(e){next(e);}
});
router.post('/mobile-money/shifts/:id/verify-opening',requireModule('mobile_money'),requirePermission('mobile_money.view'),financialThrottle,async(req,res,next)=>{
  try{const shift=await cash.decideOpening(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
    flash(req,'good','Opening count decision saved with an audit record.');require('../services/branchView.service').followRecord(req,shift);res.redirect(303,'/tenant/mobile-money/shifts');
  }catch(e){next(e);}
});
router.post('/mobile-money/shifts/:id/submit',requireModule('mobile_money'),requirePermission('mobile_money.view'),financialThrottle,async(req,res,next)=>{
  try{const shift=await cash.submit(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
    flash(req,'good','Cash count submitted for independent review; it is not a provider settlement.');require('../services/branchView.service').followRecord(req,shift);res.redirect(303,'/tenant/mobile-money/shifts');
  }catch(e){next(e);}
});
router.post('/mobile-money/shifts/:id/decide',requireModule('mobile_money'),requirePermission('mobile_money.view'),financialThrottle,async(req,res,next)=>{
  try{const shift=await cash.decide(req.tenantDb,req.tenant,req.user,req.params.id,req.body);
    flash(req,'good','Cash reconciliation decision saved and audited.');require('../services/branchView.service').followRecord(req,shift);res.redirect(303,'/tenant/mobile-money/shifts');
  }catch(e){next(e);}
});
router.get('/mobile-money/shifts/:id',requireModule('mobile_money'),requirePermission('mobile_money.view'),(req,res)=>{
 res.redirect(303,'/tenant/cash/shifts/'+encodeURIComponent(req.params.id));
});
router.get('/mobile-money/:id/acknowledgement',requireModule('mobile_money'),requirePermission('mobile_money.view'),async(req,res,next)=>{
  try{
    const record=await mobile.getRecordDetails(req.tenantDb,req.params.id,recordScope(req));
    res.set('Cache-Control','private, no-store');res.set('X-Robots-Tag','noindex, nofollow');
    const timeZone=businessTime.forBranch((res.locals.viewBranches||[]).find(b=>String(b._id)===String(record.branchId))||req.operationBranch);
    res.render('tenant/mobile-money/acknowledgement',{...require('../services/receipt.service').acknowledgement(mobile.visibleRecordForRole(record,req.user.role)),identity:req.workspaceIdentity,flash:consumeFlash(req),
      businessTimeZone:timeZone,formatLocalDate:value=>businessTime.format(value,timeZone)});
  }catch(e){next(e);}
});
router.get('/mobile-money/history', requireModule('mobile_money'),requirePermission('mobile_money.view'),async(req,res,next)=>{
  try{
    const reportZone=await reportTimeZone.forRequest(req);
    const records=await mobile.getTransactionPage(req.tenantDb,{...recordScope(req),from:req.query.from,to:req.query.to,cursor:req.query.cursor,timeZone:reportZone});
    if(hasPermission(req.user,'treasury.view')){
     const sources=records.items.filter(row=>row.fundingState==='book_recorded'&&row.fundsSourceRef).map(row=>({
      recordId:row._id,sourceType:row.fundsSourceRef.startsWith('MFX:')?'forex':'mobile_money',
      sourceRef:row.fundsSourceRef,stage:'Cash / float'}));
     const snapshots=await require('../services/recordBalances.service').snapshots(req.tenantDb,req.tenant,req.user,sources);
     records.items=records.items.map(row=>({...row,balanceAfter:snapshots.get(String(row._id))||[]}));
    }
    renderTenant(req,res,'mobile-money/history','Mobile Money History',
      'Tenant and branch-scoped operational records, with auditable correction status.',{records});
  }catch(e){next(e);}
});
router.get('/mobile-money/:id',requireModule('mobile_money'),requirePermission('mobile_money.view'),async(req,res,next)=>{
  try{
    const record=await mobile.getRecordDetails(req.tenantDb,req.params.id,recordScope(req));
    // Read-only Viewers see lifecycle states without the investigator notes.
    const visible=mobile.visibleRecordForRole(record,req.user.role);
    const canViewFunds=hasPermission(req.user,'treasury.view');
    const afterBalances=canViewFunds&&record.fundingState==='book_recorded'&&record.fundsSourceRef?
     (await require('../services/recordBalances.service').snapshots(req.tenantDb,req.tenant,req.user,[{
      recordId:record._id,sourceType:record.fundsSourceRef.startsWith('MFX:')?'forex':'mobile_money',
      sourceRef:record.fundsSourceRef,stage:'Cash / float'
     }])).get(String(record._id))||[]:[];
    const walletObservation=canViewFunds&&record.walletObservationId?await require('../treasury/models').models(req.tenantDb).observation.findOne({
      _id:record.walletObservationId,tenantId:req.tenant._id,branchId:record.branchId,accountId:record.walletAccountId
    }).select('status observedAt actualMinor expectedMinorAtRequest varianceMinorAtRequest expectedMinorAtReview varianceMinorAtReview evidenceType evidenceReference reviewedAt').lean():null;
    const canRequestCorrection=['Tenant Owner','Mobile Money Operator'].includes(req.user.role)&&
      String(record.operatorId)===String(req.user.id)&&['recorded','pending_verification'].includes(record.status)&&
      ['none','denied',null,undefined].includes(record.correctionState)&&(record.correctionAttempts||0)<5;
    const canReviewCorrection=['Tenant Owner','Branch Manager','Reconciliation Officer'].includes(req.user.role)&&
      String(record.operatorId)!==String(req.user.id)&&['recorded','pending_verification'].includes(record.status)&&record.correctionState==='requested';
    renderTenant(req,res,'mobile-money/detail','Mobile Money Record',
      'Historical evidence and internal correction decisions. No status claims external settlement.',
      {record:visible,canRequestCorrection,canReviewCorrection,canViewFunds,walletObservation,afterBalances,formatMoneyMinor:mobile.formatMoneyMinor});
  }catch(e){next(e);}
});
router.get('/audit',requirePermission('audit.view'),async(req,res,next)=>{
  try {
    const view=require('../services/branchView.service').readScope(req.user);
    const auditScope=['Tenant Owner','Auditor'].includes(req.user.role)?(view.branchId?{'metadata.branchId':String(view.branchId)}:{}):{'metadata.branchId':req.user.branchId||'__unassigned__'};
    const logs=await require('../models').auditEventModel(req.tenantDb).find(auditScope)
      .sort({createdAt:-1}).limit(100).lean();
    renderTenant(req,res,'audit/index','Operations Audit','Tenant event history, including recording and independent review.',{logs});
  }catch(e){next(e);}
});
router.use('/analytics',requireModule('analytics'),require('./analytics.routes')({renderTenant}));
router.use('/approvals',requireModule('approval_workflows'),require('./approvals.routes')({renderTenant}));
router.use('/notifications',requireModule('notifications'),require('./notification.routes')({renderTenant}));
router.get('/reports', requireModule('reports'), requirePermission('reports.view'), async(req,res,next)=>{
  try{
    const timeZone=await reportTimeZone.forRequest(req);
    const report=await require('../services/operationsReports.service').generate(req.tenantDb,req.tenant,req.user,req.query,timeZone);
    renderTenant(req,res,'reports/index','Operations Reports','Standalone, access-controlled reporting across subscribed modules.',{
      report,canExport:hasPermission(req.user,'reports.export')
    });
  }catch(e){next(e);}
});
router.get('/reports/export.csv', requireModule('reports'), requirePermission('reports.export'), async(req,res,next)=>{
  try{
    const reporting=require('../services/operationsReports.service');
    const timeZone=await reportTimeZone.forRequest(req);
    const report=await reporting.generate(req.tenantDb,req.tenant,req.user,req.query,timeZone);
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition','attachment; filename="classicfin-operations-report.csv"');
    res.setHeader('Cache-Control','private, no-store');
    res.send(reporting.csv(report));
  }catch(e){next(e);}
});
router.get('/users', requirePermission('users.manage_branch'), async (req,res,next)=>{
  try {
    const { tenantUserModel,staffInviteModel }=require('../models');
    const [users,invitations]=await Promise.all([
      tenantUserModel(req.tenantDb).find({...staffPolicy.directoryFilter(req.user),...require('../services/branchView.service').readScope(req.user)}).select('name email role status branchId allowedModules').sort({createdAt:-1}).limit(100).lean(),
      staffInviteModel(req.tenantDb).find({status:'pending',expiresAt:{$gt:new Date()},...staffPolicy.directoryFilter(req.user),...require('../services/branchView.service').readScope(req.user)}).select('name email role branchId allowedModules expiresAt').lean()
    ]);
    const inviteKeys=invitations.map(i=>'tenant.staff.invited:'+String(i._id));
    const deliveryRows=inviteKeys.length?await require('../../platform/models/OutboxEvent').find({
      tenantId:req.tenant._id,type:'tenant.staff.invited',eventKey:{$in:inviteKeys}
    }).select('eventKey state failureCode providerAcceptance.acceptedAt').lean():[];
    const deliveries=Object.fromEntries(deliveryRows.map(row=>[
      row.eventKey.replace(/^tenant\\.staff\\.invited:/,''),{
        state:row.state,failureCode:row.failureCode||null,acceptedAt:row.providerAcceptance?.acceptedAt||null
      }
    ]));
    const roleModuleService=require('../services/roleModules.service');
    const roles=staffPolicy.managedRoles(req.user);
    const [roleDefaults,activeBranches]=await Promise.all([
      roleModuleService.all(req.tenantDb,req.tenant),branchService.list(req.tenant)
    ]);
    const allowedByRole=Object.fromEntries(roles.map(role=>[role,
      roleModuleService.defaultModules(req.tenant,role).filter(key=>
        req.user.role==='Tenant Owner'||hasModuleForUser(req.tenant,req.user,key))]));
    renderTenant(req,res,'users/index','Staff & Roles','Choose staff roles and subscribed modules for each account.',{
      users,invitations,inviteDeliveries:deliveries,roles,roleDefaults,allowedByRole,
      plan:planForTenant(req.tenant),inviteMailReady:require('../../config/inviteMail').configured(),
      moduleAccessByUser:Object.fromEntries(users.map(account=>[String(account._id),Object.fromEntries((account.role==='Tenant Owner'?require('../../data/store').modules.map(m=>m.key):account.allowedModules||[]).map(key=>[key,require('../services/moduleAccess.service').moduleAccessState(req.tenant,{
       id:String(account._id),status:account.status,role:account.role,allowedModules:account.allowedModules,permissions:require('../../config/roles').permissionsFor(account.role)
      },key)]))])),
      branches:activeBranches.filter(b=>b.status==='active' && (req.user.role==='Tenant Owner' || String(b._id)===String(req.user.branchId))),
      assignable:[...new Set(Object.values(allowedByRole).flat())]
    });
  }catch(e){next(e);}
});
router.get('/users/:id/edit',requirePermission('users.manage_branch'),async(req,res,next)=>{
  try{
    if(!/^[a-f0-9]{24}$/i.test(String(req.params.id)))return res.status(404).send('Staff not found');
    const account=await require('../models').tenantUserModel(req.tenantDb).findOne({_id:req.params.id,...staffPolicy.staffFilter(req.user)}).select('name email role status branchId allowedModules').lean();
    if(!account)return res.status(404).send('Staff not found');
    const roleModuleService=require('../services/roleModules.service');
    const roles=staffPolicy.managedRoles(req.user);
    const [roleDefaults,branches]=await Promise.all([
      roleModuleService.all(req.tenantDb,req.tenant),branchService.list(req.tenant)
    ]);
    const allowedByRole=Object.fromEntries(roles.map(role=>[role,
      roleModuleService.defaultModules(req.tenant,role).filter(key=>
        req.user.role==='Tenant Owner'||hasModuleForUser(req.tenant,req.user,key))]));
    renderTenant(req,res,'users/edit','Edit Staff Access','Change staff role and active module assignments.',{
      account,roles,roleDefaults,allowedByRole,
      branches:branches.filter(b=>b.status==='active' && (req.user.role==='Tenant Owner' || String(b._id)===String(req.user.branchId))),
      assignable:[...new Set(Object.values(allowedByRole).flat())]
    });
  }catch(e){next(e);}
});
router.post('/users/role-defaults',requirePermission('users.manage'),async(req,res,next)=>{
  try{
    await require('../services/roleModules.service').save(req.tenantDb,req.tenant,req.user,req.body);
    flash(req,'good',req.body.applyExisting==='yes'
      ?'Role default modules saved and applied to existing staff. Active sessions must sign in again before gaining new access.'
      :'Role default modules saved. New staff assignments will use this role template.');
    res.redirect(303,'/tenant/users');
  }catch(e){if([400,403,409].includes(e?.status)){flash(req,'bad',e.message);return res.redirect(303,'/tenant/users');}next(e);}
});
router.post('/users/invite',requirePermission('users.manage_branch'),async(req,res,next)=>{
  try{
    const inviteUrl=await require('../services/staff.service').issueInvite(req.tenant,req.user,req.body);
    renderTenant(req,res,'users/invite','Staff invitation created','Secure one-time activation.',{inviteUrl,inviteQueued:require('../../config/inviteMail').configured()});
  }catch(e){
    // Input, quota, branch, duplicate identity and permission failures are safe
    // actionable business messages. Keep internal provider/db failures out of
    // the UI and route them to the central request-ID error handler.
    if([400,403,409,422].includes(e?.status)){
      flash(req,'bad',e.message);
      return res.redirect(303,'/tenant/users');
    }
    next(e);
  }
});
router.post('/users/:id/disable',requirePermission('users.manage_branch'),async(req,res,next)=>{
  try{await require('../services/staff.service').disableStaff(req.tenant,req.user,req.params.id);
    flash(req,'good','Staff account disabled. Existing sessions will be rejected on their next request.');res.redirect(303,'/tenant/users');
  }catch(e){next(e);}
});

router.post('/users/:id/update',requirePermission('users.manage_branch'),async(req,res,next)=>{
  try{await staffService.updateStaff(req.tenant,req.user,req.params.id,req.body);flash(req,'good','Staff access saved. Removed rights take effect immediately; newly granted rights require the staff member to sign in again.');res.redirect(303,'/tenant/users');}catch(e){next(e);}
});
router.post('/users/invitations/:id/revoke',requirePermission('users.manage_branch'),async(req,res,next)=>{
  try{await staffService.cancelInvite(req.tenant,req.user,req.params.id);flash(req,'good','Invitation revoked. Seat released.');res.redirect(303,'/tenant/users');}catch(e){next(e);}
});
router.post('/users/:id/enable',requirePermission('users.manage_branch'),async(req,res,next)=>{
  try{await staffService.enableStaff(req.tenant,req.user,req.params.id);flash(req,'good','Staff account restored with a seat reservation.');res.redirect(303,'/tenant/users');}catch(e){next(e);}
});
router.get('/branches',requirePermission('branches.view'),async(req,res,next)=>{
  try{const branches=await branchService.list(req.tenant);
    const permitted=req.user.role==='Tenant Owner'?branches:branches.filter(b=>String(b._id)===String(req.user.branchId));
    const showArchived=req.query.status==='archived';
    renderTenant(req,res,'branches/index','Branch Management','Active branch limits, staff assignments and audited changes.',{
      branches:permitted.filter(b=>b.status===(showArchived?'archived':'active')),
      activeCount:permitted.filter(b=>b.status==='active').length,
      archivedCount:permitted.filter(b=>b.status==='archived').length,showArchived,
      plan:planForTenant(req.tenant),canManage:req.user.role==='Tenant Owner'
    });
  }catch(e){next(e);}
});
router.post('/branches',requirePermission('branches.manage'),async(req,res,next)=>{
  try{await branchService.create(req.tenant,req.user,req.body);flash(req,'good','Branch created and audited.');res.redirect(303,'/tenant/branches');}catch(e){next(e);}
});
router.post('/branches/operating',requirePermission('branches.manage'),async(req,res,next)=>{
  try{await branchService.setOperatingBranch(req.tenant,req.user,req.body.branchId);flash(req,'good','Your operating branch is saved. New transactions will use it automatically.');res.redirect(303,'/tenant/branches');}catch(e){next(e);}
});
router.post('/branches/:id/update',requirePermission('branches.manage'),async(req,res,next)=>{
  try{await branchService.update(req.tenant,req.user,req.params.id,req.body);flash(req,'good','Branch updated and audited.');res.redirect(303,'/tenant/branches');}catch(e){next(e);}
});
router.post('/branches/:id/archive',requirePermission('branches.manage'),async(req,res,next)=>{
  try{await branchService.archive(req.tenant,req.user,req.params.id);flash(req,'good','Branch archived. Historical records retained.');res.redirect(303,'/tenant/branches');}catch(e){next(e);}
});
router.post('/branches/:id/restore',requirePermission('branches.manage'),async(req,res,next)=>{
  try{await branchService.restore(req.tenant,req.user,req.params.id);flash(req,'good','Branch restored.');res.redirect(303,'/tenant/branches');}catch(e){next(e);}
});
router.post('/modules/request',requirePermission('modules.view'),async(req,res,next)=>{
  try{await require('../../platform/services/moduleRequest.service').submit(req.tenant,req.user,req.body);
    flash(req,'good','Module request recorded for platform review. No charge was made.');res.redirect(303,'/tenant/modules');
  }catch(e){next(e);}
});
router.get('/modules',requirePermission('modules.view'),async(req,res,next)=>{
  try{
    const pending=req.user.role==='Tenant Owner' ? await require('../../platform/models/ModuleRequest').find({tenantId:req.tenant._id,status:'pending'}).select('moduleKey').lean():[];
    renderTenant(req,res,'modules/index','Tenant Modules','Your independently subscribed modules and permissions.',{
      modules,plan:planForTenant(req.tenant),grants:require('../../platform/services/moduleSubscriptions.service').activeGrants(req.tenant),
       moduleAccessStates:Object.fromEntries(modules.map(m=>[m.key,require('../services/moduleAccess.service').moduleAccessState(req.tenant,req.user,m.key)])),
      pendingKeys:pending.map(p=>p.moduleKey)
    });
  }catch(e){next(e);}
});
router.get('/billing',requirePermission('billing.view'),async(req,res,next)=>{
  try{
    const s=req.tenant.subscription;
    const period=new Date().toISOString().slice(0,7);
    const addon=require('../../platform/services/moduleSubscriptions.service').effectiveModuleGrant(req.tenant,'mobile_money');
    const planMobile=effectiveSubscription(req.tenant)&&s&&s.modules.includes('mobile_money')&&req.tenant.enabledModules?.includes('mobile_money');
    const meter=planMobile?{generation:s.generation,metric:'mobile_money_records'}:addon?{generation:1000000000+addon.generation,metric:'addon_mobile_money_records'}:null;
    const usage=meter?await UsageCounter.findOne({tenantId:req.tenant._id,generation:meter.generation,period,metric:meter.metric}).lean():null;
    const transferAddon=require('../../platform/services/moduleSubscriptions.service').effectiveModuleGrant(req.tenant,'money_transfer');
    const planTransfer=effectiveSubscription(req.tenant)&&s&&s.modules.includes('money_transfer')&&req.tenant.enabledModules?.includes('money_transfer');
    const transferMeter=planTransfer?{generation:s.generation,metric:'money_transfer_requests'}:transferAddon?{generation:1000000000+transferAddon.generation,metric:'addon_money_transfer_requests'}:null;
    const transferUsage=transferMeter?await UsageCounter.findOne({tenantId:req.tenant._id,generation:transferMeter.generation,period,metric:transferMeter.metric}).lean():null;
    const bankAddon=require('../../platform/services/moduleSubscriptions.service').effectiveModuleGrant(req.tenant,'banking');
    const planBank=effectiveSubscription(req.tenant)&&s&&s.modules.includes('banking')&&req.tenant.enabledModules?.includes('banking');
    const bankMeter=planBank?{generation:s.generation,metric:'banking_requests'}:bankAddon?{generation:1000000000+bankAddon.generation,metric:'addon_banking_requests'}:null;
    const bankUsage=bankMeter?await UsageCounter.findOne({tenantId:req.tenant._id,generation:bankMeter.generation,period,metric:bankMeter.metric}).lean():null;
    const fxAddon=require('../../platform/services/moduleSubscriptions.service').effectiveModuleGrant(req.tenant,'forex');
    const planForex=effectiveSubscription(req.tenant)&&s&&s.modules.includes('forex')&&req.tenant.enabledModules?.includes('forex');
    const forexMeter=planForex?{generation:s.generation,metric:'forex_quotes'}:fxAddon?{generation:1000000000+fxAddon.generation,metric:'addon_forex_quotes'}:null;
    const forexUsage=forexMeter?await UsageCounter.findOne({tenantId:req.tenant._id,generation:forexMeter.generation,period,metric:forexMeter.metric}).lean():null;
    renderTenant(req,res,'billing/index','Billing & Plan','Verified subscription terms, remaining limits and recorded usage.',{
      plan:planForTenant(req.tenant),subscription:s||null,usage:usage?.quantity||0,transferUsage:transferUsage?.quantity||0,bankUsage:bankUsage?.quantity||0,forexUsage:forexUsage?.quantity||0,forexLimit:planForex?s.limits.transactionsPerMonth:fxAddon?.limits.recordsPerMonth,bankLimit:planBank?s.limits.transactionsPerMonth:bankAddon?.limits.recordsPerMonth,transferLimit:planTransfer?s.limits.transactionsPerMonth:transferAddon?.limits.recordsPerMonth,period,mobileMoneyLimit:planMobile?s.limits.transactionsPerMonth:addon?.limits.recordsPerMonth,grants:require('../../platform/services/moduleSubscriptions.service').activeGrants(req.tenant)
    });
  }catch(e){next(e);}
});
router.use('/money-transfer',requireModule('money_transfer'),require('./moneyTransfer.routes')({renderTenant}));
router.use('/banking',requireModule('banking'),require('./banking.routes')({renderTenant}));
router.use('/forex',requireModule('forex'),require('./forex.routes')({renderTenant}));
router.use((req,res)=>res.status(404).type('text/plain').send('This page could not be found.'));
module.exports = router;
