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
const staffService=require('../services/staff.service');
const staffPolicy=require('../services/staffPolicy');
router.use(require('./offline.routes'));
router.get('/workspace/theme.css',require('../workspace/routes').theme);
router.use(async(req,res,next)=>{try{
 await Promise.all([
  new Promise((resolve,reject)=>require('../services/transactionBranch.service').requestContext(req,res,error=>error?reject(error):resolve())),
  require('../workspace/service').receiptIdentity(req.tenantDb,req.tenant).then(identity=>{req.workspaceIdentity=identity;})
 ]);
 next();
}catch(error){next(error);}});
router.use(require('../../middleware/requireOfflineContext'));
router.use((req,res,next)=>{const phone=phoneCountry;res.locals.phoneDefaults=phone.defaults(req);if(req.method==='POST')for(const field of ['phone','senderPhone','receiverPhone','customerPhone','supportPhone','nextOfKinPhone','legacyReceiverPhone'])if(typeof req.body?.[field]==='string'&&req.body[field])req.body[field]=phone.normalize(req.body[field],field==='senderPhone'&&req.body.senderCountry?req.body.senderCountry:field==='receiverPhone'&&req.body.receiverCountry?req.body.receiverCountry:req.get('x-classicfin-phone-country')||res.locals.phoneDefaults.country);next();});
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
    tenant:{...req.tenant,name:req.workspaceIdentity?.name||req.tenant.name}, user:req.user, menu:tenantMenu(req.tenant,req.user),
    view:`../tenant/${view}`, data, flash:consumeFlash(req), money, formatUtcDate, amountFromMinor:mobile.fromMinor
  });
}
router.use('/backups',require('../backups/routes')({renderTenant}));
router.use('/treasury',require('../treasury/routes')({renderTenant}));
router.use('/funded',require('./fundedOperations.routes')({renderTenant}));
router.use(require('./cashControl.routes')({renderTenant}));
router.use(require('./dayControl.routes')({renderTenant,recordScope}));
router.use('/mobile-money',require('./mobileMoneyWorkspace.routes')({renderTenant}));
router.use(require('../customerAccounts/routes')({renderTenant}));
router.use('/workspace',require('../workspace/routes')({renderTenant}));
router.use(require('./expenses.routes')({renderTenant}));
router.use(require('./approvedReports.routes')({renderTenant}));
router.get('/', (req,res)=>res.redirect(303,'/tenant/dashboard'));
router.get('/dashboard', requirePermission('dashboard.view'), async (req,res,next)=>{
  try {
    // Indexes are prepared by provisioning and awaited by mutation services.
    // Reading an overview must not start collection/index DDL after a restart.
    const overview=await require('../services/dashboardOverview.service').overview(req.tenantDb,req.tenant,req.user,{operationBranch:req.operationBranch,currency:req.query.currency,viewBranch:req.viewBranch,viewBranchId:req.viewBranchId});
    renderTenant(req,res,'dashboard/index','Overview','Money transfer, mobile money, banking, forex, tenants, roles, reports, analytics, and daily controls.',overview);
  } catch(e) { next(e); }
});
router.get('/mobile-money', requireModule('mobile_money'), requirePermission('mobile_money.view'), async (req,res,next)=>{
  try {
    const canReview=hasPermission(req.user,'mobile_money.review')&&(req.user.role==='Tenant Owner'||req.user.branchId);
    const reviewBranch=req.user.role==='Tenant Owner'?(require('../services/branchView.service').readScope(req.user).branchId||null):req.user.branchId;
    const [summary,branches,reviewQueue,voidQueue,funds]=await Promise.all([
      mobile.getSummary(req.tenantDb,recordScope(req)),
      branchService.list(req.tenant),
      canReview?mobile.getReviewQueue(req.tenantDb,req.user.id,25,reviewBranch):[],
      canReview?mobile.getVoidQueue(req.tenantDb,req.user.id,25,reviewBranch):[],
      req.operationBranch&&hasPermission(req.user,'treasury.view')?require('../services/mobileMoneyFunds.service').context(req.tenantDb,req.tenant,req.user,req.operationBranch):null
    ]);
    renderTenant(req,res,'mobile-money/index','Mobile Money','Record agent transactions. Provider settlement remains unverified until reconciled.',{
      entryCurrency:req.operationBranch?require('../services/branchCurrency.service').resolve(req.operationBranch,req.query.currency):null,
      entryCurrencies:req.operationBranch?require('../services/branchCurrency.service').options(req.operationBranch):[],
      summary,branches:branches.filter(b=>b.status==='active' && (req.user.role==='Tenant Owner' || String(b._id)===String(req.user.branchId))),reviewQueue,voidQueue,funds,
      canReview: hasPermission(req.user,'mobile_money.review'), idempotencyKey:randomUUID(),
      canRecord: hasPermission(req.user,'mobile_money.cash_in') || hasPermission(req.user,'mobile_money.cash_out')
    });
  } catch(e) { next(e); }
});
for (const [path,op,permission] of [['cash-in','cash_in','mobile_money.cash_in'],['cash-out','cash_out','mobile_money.cash_out']]) {
  router.post(`/mobile-money/${path}`, requireModule('mobile_money'),requirePermission(permission),require('../../platform/services/actionThrottle.service').financial,async(req,res,next)=>{
    try {
      const result = await mobile.recordMobileMoney(req.tenantDb,req.user,req.body,op,req.tenant,null,{requireFunds:true});
      flash(req,'good',result.duplicate ? 'This request was already recorded. No duplicate created.' : 'Transaction recorded for verification. No provider settlement has been claimed.');
      require('../services/branchView.service').followRecord(req,result.created);
      res.redirect(303,'/tenant/mobile-money');
    } catch(e) { next(e); }
  });
}
router.post('/mobile-money/:id/review', requireModule('mobile_money'), requirePermission('mobile_money.review'),
  require('../../platform/services/actionThrottle.service').financial, async(req,res,next)=>{
  try {
    await mobile.reviewMobileMoney(req.tenantDb, req.user, req.params.id, req.body.decision, req.body.note);
    flash(req,'good','Independent review saved and audited. Provider settlement is still unverified.');
    res.redirect(303,'/tenant/mobile-money');
  } catch(e) { next(e); }
});
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
// Physical cash count shifts are internal operational evidence, not provider float.
const cash=require('../services/cashDrawer.service');
const financialThrottle=require('../../platform/services/actionThrottle.service').financial;
router.get('/mobile-money/shifts',requireModule('mobile_money'),requirePermission('mobile_money.view'),async(req,res,next)=>{
  try{
    const [shifts,branches]=await Promise.all([cash.list(req.tenantDb,req.tenant,req.user,{cursor:req.query.cursor}),branchService.list(req.tenant)]);
    const operators=await require('../models').tenantUserModel(req.tenantDb)
      .find({_id:{$in:shifts.items.map(x=>x.operatorId)}}).select('_id name').lean();
    const branchNames=Object.fromEntries(branches.map(x=>[String(x._id),x.name]));
    const operatorNames=Object.fromEntries(operators.map(x=>[String(x._id),x.name]));
    renderTenant(req,res,'mobile-money/shifts','Physical Cash Shifts','Operator cash counts and independent branch reconciliation; not electronic float or provider settlement.',
      {shifts,branchNames,operatorNames,branches:branches.filter(b=>b.status==='active'&&(req.user.role==='Tenant Owner'||String(b._id)===String(req.user.branchId))),
        canOpen:cash.opener(req.user),canReview:cash.reviewer(req.user)});
  }catch(e){next(e);}
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
router.get('/mobile-money/shifts/:id',requireModule('mobile_money'),requirePermission('mobile_money.view'),async(req,res,next)=>{
  try{
    const shift=await cash.detail(req.tenantDb,req.tenant,req.user,req.params.id);
    renderTenant(req,res,'mobile-money/shift-detail','Cash Shift Detail','Internal physical cash reconciliation history. No provider float or cleared balance claims.',
     {shift,canSubmit:cash.opener(req.user)&&String(shift.operatorId)===String(req.user.id)&&['open','disputed'].includes(shift.status),
      canReview:cash.reviewer(req.user)&&String(shift.operatorId)!==String(req.user.id)&&shift.status==='submitted',
      canReviewOpening:cash.reviewer(req.user)&&String(shift.operatorId)!==String(req.user.id)&&shift.status==='pending_open',
      canApprove:shift.varianceMinor==null||String(shift.varianceMinor)==='0'||req.user.role!=='Branch Manager'});
  }catch(e){next(e);}
});
router.get('/mobile-money/:id/acknowledgement',requireModule('mobile_money'),requirePermission('mobile_money.view'),async(req,res,next)=>{
  try{
    const record=await mobile.getRecordDetails(req.tenantDb,req.params.id,recordScope(req));
    res.set('Cache-Control','private, no-store');res.set('X-Robots-Tag','noindex, nofollow');
    res.render('tenant/mobile-money/acknowledgement',{...require('../services/receipt.service').acknowledgement(mobile.visibleRecordForRole(record,req.user.role)),identity:req.workspaceIdentity,flash:consumeFlash(req)});
  }catch(e){next(e);}
});
router.get('/mobile-money/history', requireModule('mobile_money'),requirePermission('mobile_money.view'),async(req,res,next)=>{
  try{
    const records=await mobile.getTransactionPage(req.tenantDb,{...recordScope(req),from:req.query.from,to:req.query.to,cursor:req.query.cursor});
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
    const walletObservation=canViewFunds&&record.walletObservationId?await require('../treasury/models').models(req.tenantDb).observation.findOne({
      _id:record.walletObservationId,tenantId:req.tenant._id,branchId:record.branchId,accountId:record.walletAccountId
    }).select('status observedAt actualMinor expectedMinorAtRequest varianceMinorAtRequest expectedMinorAtReview varianceMinorAtReview evidenceType evidenceReference reviewedAt').lean():null;
    const canRequestCorrection=['Tenant Owner','Mobile Money Operator'].includes(req.user.role)&&
      String(record.operatorId)===String(req.user.id)&&record.status==='pending_verification'&&
      ['none','denied',null,undefined].includes(record.correctionState)&&(record.correctionAttempts||0)<5;
    const canReviewCorrection=['Tenant Owner','Reconciliation Officer'].includes(req.user.role)&&
      String(record.operatorId)!==String(req.user.id)&&record.status==='pending_verification'&&record.correctionState==='requested';
    renderTenant(req,res,'mobile-money/detail','Mobile Money Record',
      'Historical evidence and internal correction decisions. No status claims external settlement.',
      {record:visible,canRequestCorrection,canReviewCorrection,canViewFunds,walletObservation,formatMoneyMinor:mobile.formatMoneyMinor});
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
    const report=await require('../services/operationsReports.service').generate(req.tenantDb,req.tenant,req.user,req.query);
    renderTenant(req,res,'reports/index','Operations Reports','Standalone, access-controlled reporting across subscribed modules.',{
      report,canExport:hasPermission(req.user,'reports.export')
    });
  }catch(e){next(e);}
});
router.get('/reports/export.csv', requireModule('reports'), requirePermission('reports.export'), async(req,res,next)=>{
  try{
    const reporting=require('../services/operationsReports.service');
    const report=await reporting.generate(req.tenantDb,req.tenant,req.user,req.query);
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
    renderTenant(req,res,'users/index','Staff & Roles','Invite staff with fixed permissions, disable access immediately and monitor seat limits.',{
      users,invitations,roles:staffPolicy.managedRoles(req.user),plan:planForTenant(req.tenant),
      branches:(await branchService.list(req.tenant)).filter(b=>b.status==='active' && (req.user.role==='Tenant Owner' || String(b._id)===String(req.user.branchId))),
      assignable:require('../services/moduleAccess.service').assignableModules(req.tenant,req.user.role==='Tenant Owner'?'Tenant Owner':'Branch Manager').filter(m=>req.user.role==='Tenant Owner'||hasModuleForUser(req.tenant,req.user,m))
    });
  }catch(e){next(e);}
});
router.get('/users/:id/edit',requirePermission('users.manage_branch'),async(req,res,next)=>{
  try{
    if(!/^[a-f0-9]{24}$/i.test(String(req.params.id)))return res.status(404).send('Staff not found');
    const account=await require('../models').tenantUserModel(req.tenantDb).findOne({_id:req.params.id,...staffPolicy.staffFilter(req.user)}).select('name email role status branchId allowedModules').lean();
    if(!account)return res.status(404).send('Staff not found');
    renderTenant(req,res,'users/edit','Edit Staff Access','Change staff role, assigned branch and module restrictions. Existing sessions will be revoked.',{
      account,branches:(await branchService.list(req.tenant)).filter(b=>b.status==='active' && (req.user.role==='Tenant Owner' || String(b._id)===String(req.user.branchId))),
      roles:staffPolicy.managedRoles(req.user),
      assignable:require('../services/moduleAccess.service').assignableModules(req.tenant,req.user.role==='Tenant Owner'?'Tenant Owner':'Branch Manager').filter(m=>req.user.role==='Tenant Owner'||hasModuleForUser(req.tenant,req.user,m))
    });
  }catch(e){next(e);}
});
router.post('/users/invite',requirePermission('users.manage_branch'),async(req,res,next)=>{
  try{
    const inviteUrl=await require('../services/staff.service').issueInvite(req.tenant,req.user,req.body);
    renderTenant(req,res,'users/invite','Staff invitation created','Share the private link securely. It is displayed only once.',{inviteUrl});
  }catch(e){next(e);}
});
router.post('/users/:id/disable',requirePermission('users.manage_branch'),async(req,res,next)=>{
  try{await require('../services/staff.service').disableStaff(req.tenant,req.user,req.params.id);
    flash(req,'good','Staff account disabled. Existing sessions will be rejected on their next request.');res.redirect(303,'/tenant/users');
  }catch(e){next(e);}
});

router.post('/users/:id/update',requirePermission('users.manage_branch'),async(req,res,next)=>{
  try{await staffService.updateStaff(req.tenant,req.user,req.params.id,req.body);flash(req,'good','Account updated. Existing sessions were revoked.');res.redirect(303,'/tenant/users');}catch(e){next(e);}
});
router.post('/users/invitations/:id/revoke',requirePermission('users.manage_branch'),async(req,res,next)=>{
  try{await staffService.cancelInvite(req.tenant,req.user,req.params.id);flash(req,'good','Invitation revoked. Seat released.');res.redirect(303,'/tenant/users');}catch(e){next(e);}
});
router.post('/users/:id/enable',requirePermission('users.manage_branch'),async(req,res,next)=>{
  try{await staffService.enableStaff(req.tenant,req.user,req.params.id);flash(req,'good','Staff account restored with a seat reservation.');res.redirect(303,'/tenant/users');}catch(e){next(e);}
});
router.get('/branches',requirePermission('branches.view'),async(req,res,next)=>{
  try{const branches=await branchService.list(req.tenant);
    renderTenant(req,res,'branches/index','Branch Management','Active branch limits, staff assignments and audited changes.',{
      branches: req.user.role==='Tenant Owner' ? branches : branches.filter(b=>String(b._id)===String(req.user.branchId)),
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
