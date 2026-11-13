const router = require('express').Router();
const Tenant = require('../models/Tenant');
const Appointment = require('../models/Appointment');
const { modules, plans } = require('../../data/store');
const commercial=require('../services/commercial.service');
const planBuilder=require('../services/planBuilder.service');
const outbox=require('../services/outbox.service');
const appointmentService=require('../services/appointment.service');
const { platformMenu } = require('../../services/menu.service');
const { consumeFlash, flash, money, formatUtcDate } = require('../../utils/view');
const { provisionTenant,regenerateOwnerInvite } = require('../services/tenantProvisioning.service');
const { changeStatus, updateProfile }=require('../services/tenantAdmin.service');
const {list: platformAudit}=require('../services/platformAudit.service');
function renderPlatform(req,res,view,pageTitle,pageSub,data={}){
  res.render('layouts/dashboard', {
    context:'platform',currentPath:req.baseUrl + req.path,pageTitle,pageSub,tenant:null,user:req.platformUser,menu:platformMenu(req.platformUser),
    view:`../platform/${view}`,data,flash:consumeFlash(req),money,formatUtcDate
  });
}
router.use((req,res,next)=>req.platformUser.permissions.includes('*')?next():res.status(403).send('Insufficient permissions'));
router.get('/',(req,res)=>res.redirect(303,'/platform/dashboard'));
router.get('/dashboard',async(req,res,next)=>{
  try{
    const [tenants,appointmentCount,totalTenants,activeTenants,suspendedTenants,recentAudits]=await Promise.all([Tenant.find({}).sort({createdAt:-1}).limit(30).lean(),Appointment.countDocuments(),Tenant.countDocuments(),Tenant.countDocuments({status:'active'}),Tenant.countDocuments({status:'suspended'}),platformAudit(6)]);
    renderPlatform(req,res,'dashboard/index','Platform Dashboard','Manage workspaces, plans and onboarding.',{
      tenants:tenants.map(t=>({...t,id:String(t._id)})), appointmentCount, totalTenants,activeTenants,suspendedTenants,recentAudits, availableModuleCount:modules.filter(m=>m.runtimeStatus!=='disabled').length
    });
  }catch(e){next(e);}
});
router.get('/tenants',async(req,res,next)=>{
  try {const tenants=(await Tenant.find({}).sort({createdAt:-1}).limit(100).lean()).map(t=>({...t,id:String(t._id)}));
    renderPlatform(req,res,'tenants/index','Tenants','Tenant directories, plan assignment, isolation boundaries and status.',{tenants,plans,modules});
  }catch(e){next(e);}
});
async function renderTenantCreate(req,res,values={},error=null){
  const published=await commercial.publishedPlans();
  const latest=new Map();
  for(const plan of published) if(!latest.has(plan.code)) latest.set(plan.code,plan);
  renderPlatform(req,res,'tenants/create','Create Tenant','Add a workspace and invite its owner.',{
    plans:[...latest.values()].filter(p=>p.availableForNewTenants!==false),catalogueEmpty:published.length===0,modules,values,error,
    inviteMailReady:require('../../config/inviteMail').configured()
  });
}
router.get('/tenants/create',async(req,res,next)=>{
  try{await renderTenantCreate(req,res);}catch(e){next(e);}
});
router.post('/tenants',async(req,res,next)=>{
  res.setHeader('Cache-Control','no-store');
  try{
    const result=await provisionTenant({...req.body,slug:''},req.platformUser);
    renderPlatform(req,res,'tenants/invite','Tenant created',result.inviteQueued?'Activation email queued; delivery pending.':'Copy the private activation link; mail delivery is not configured.',result);
  }catch(e){
    if([400,409].includes(e.status)||e.provisioningError){
      if(e.provisioningError){
        console.error(JSON.stringify({event:'tenant.provisioning_failed',requestId:req.requestId,code:e.code,status:e.status}));
        if(e.status===503)res.setHeader('Retry-After','5');
      }
      const values=Object.fromEntries(['name','owner','email','phone','plan'].map(key=>[key,typeof req.body[key]==='string'?req.body[key]:'']));
      try{return await renderTenantCreate(req,res.status(e.status),values,e.message);}catch(renderError){return next(renderError);}
    }
    next(e);
  }
});
router.post('/tenants/:id/owner-invitation',async(req,res,next)=>{
  try{
    const result=await regenerateOwnerInvite(req.params.id,req.platformUser,req.body);
    res.setHeader('Cache-Control','no-store');
    renderPlatform(req,res,'tenants/invite','Owner activation link','Copy the replacement link securely. Earlier unused links are expired.',result);
  }catch(error){next(error);}
});
router.get('/tenants/:id',async(req,res,next)=>{
  try{
    if (!/^[a-f0-9]{24}$/i.test(req.params.id)) return res.status(404).send('Tenant not found');
    const tenant=await Tenant.findById(req.params.id).lean(); if(!tenant) return res.status(404).send('Tenant not found');
    const published=await commercial.publishedPlans();
    renderPlatform(req,res,'tenants/show',tenant.name,'Tenant profile, subscription control and audit-safe entitlements.',{tenant:{...tenant,id:String(tenant._id)},tenants:[],plans,modules,published,independentModules:require('../services/moduleSubscriptions.service').listable().map(module=>({...module,requiresRecords:require('../services/moduleSubscriptions.service').requiresRecords(module.key)}))});
  }catch(e){next(e);}
});
router.post('/tenants/:id/status',async(req,res,next)=>{
  try{await changeStatus(req.params.id,req.platformUser,req.body);flash(req,'good','Tenant status updated with an audit record.');res.redirect(303,'/platform/tenants/'+req.params.id);}catch(e){next(e);}
});
router.get('/audit',async(req,res,next)=>{
  try{const auditLogs=await platformAudit(100);renderPlatform(req,res,'audit/index','Platform Audit','Immutable review of platform administration actions.',{auditLogs});}catch(e){next(e);}
});
router.post('/tenants/:id/profile',async(req,res,next)=>{
  try{await updateProfile(req.params.id,req.platformUser,req.body);flash(req,'good','Tenant profile updated and audited.');res.redirect(303,'/platform/tenants/'+req.params.id);}catch(e){next(e);}
});
router.get('/plans',async(req,res,next)=>{
  try{renderPlatform(req,res,'plans/index','Plans & Pricing','Configure plans, prices and included services.',{plans,...await planBuilder.list()});}
  catch(e){next(e);}
});
async function renderPlanEditor(req,res,code,overrides={}){
  const [editor,published]=await Promise.all([planBuilder.editor(code),commercial.publishedPlans()]);
  const latest=new Map();for(const plan of published)if(!latest.has(plan.code))latest.set(plan.code,plan);
  renderPlatform(req,res,'plans/editor',code?'Edit plan':'Create plan','Save a draft, then publish its prices and module access.',{
    editor,values:editor.values,error:null,modules:modules.filter(module=>module.runtimeStatus!=='disabled'),
    manualPlans:[...latest.values()].filter(plan=>plan.entryMode!=='sms_assisted'&&!plan.modules.includes('sms_capture')),...overrides
  });
}
router.get('/plans/new',async(req,res,next)=>{
  try{await renderPlanEditor(req,res);}catch(error){next(error);}
});
router.get('/plans/:code/edit',async(req,res,next)=>{
  try{await renderPlanEditor(req,res,req.params.code);}catch(error){next(error);}
});
for(const [path,existing] of [['/plans/drafts',false],['/plans/:code/draft',true]]){
  router.post(path,async(req,res,next)=>{
    const code=existing?req.params.code:undefined;
    try{
      const draft=await planBuilder.saveDraft(req.platformUser,req.body,code);
      flash(req,'good','Plan draft saved. Review the configuration before publishing.');
      res.redirect(303,'/platform/plans/'+encodeURIComponent(draft.code)+'/edit');
    }catch(error){
      if([400,409].includes(error.status)){
        try{return await renderPlanEditor(req,res.status(error.status),code,{values:req.body,error:error.message});}catch(renderError){return next(renderError);}
      }
      next(error);
    }
  });
}
router.post('/plans/:code/publish',async(req,res,next)=>{
  try{
    const plan=await planBuilder.publishDraft(req.platformUser,req.params.code,req.body);
    flash(req,'good',`${plan.name} v${plan.version} published. Existing subscriptions keep their recorded terms.`);
    res.redirect(303,'/platform/plans');
  }catch(error){
    if([400,409].includes(error.status)){
      try{return await renderPlanEditor(req,res.status(error.status),req.params.code,{error:error.message});}catch(renderError){return next(renderError);}
    }
    next(error);
  }
});
router.post('/plans/publish-initial',async(req,res,next)=>{
  try{
    await commercial.publishCatalog({apply:true,actor:req.platformUser});
    flash(req,'good','Plans are ready. Choose a plan below to create a tenant.');
    res.redirect(303,'/platform/tenants/create');
  }catch(e){
    if([400,409].includes(e.status)){
      try{return await renderTenantCreate(req,res.status(e.status),{},e.message);}catch(renderError){return next(renderError);}
    }
    next(e);
  }
});
router.get('/subscriptions',async(req,res,next)=>{
  try{const tenants=await Tenant.find({}).sort({createdAt:-1}).limit(100).lean();
    renderPlatform(req,res,'subscriptions/index','Subscriptions','Manual grants and expiring trials, from persisted tenant records.',{tenants});
  }catch(e){next(e);}
});
router.post('/tenants/:id/subscription/grant',async(req,res,next)=>{
  try{await commercial.grantTenantSubscription(req.params.id,req.platformUser,req.body);
    flash(req,'good','Audited subscription grant saved; notification queued for background processing. No payment was collected.');
    res.redirect(303,'/platform/tenants/'+req.params.id);
  }catch(e){next(e);}
});
router.post('/tenants/:id/subscription/revoke',async(req,res,next)=>{
  try{await commercial.revokeTenantSubscription(req.params.id,req.platformUser,req.body);
    flash(req,'good','Subscription access revoked and audited; notification queued for background processing.');res.redirect(303,'/platform/tenants/'+req.params.id);
  }catch(e){next(e);}
});
router.post('/tenants/:id/modules/grant',async(req,res,next)=>{
  try{await require('../services/moduleSubscriptions.service').grantModule(req.params.id,req.platformUser,req.body);
    flash(req,'good','Audited module entitlement saved. No payment has been collected.');res.redirect(303,'/platform/tenants/'+req.params.id);
  }catch(e){next(e);}
});
router.post('/tenants/:id/modules/revoke',async(req,res,next)=>{
  try{await require('../services/moduleSubscriptions.service').revokeModule(req.params.id,req.platformUser,req.body);
    flash(req,'good','Standalone module entitlement revoked.');res.redirect(303,'/platform/tenants/'+req.params.id);
  }catch(e){next(e);}
});
router.get('/modules/requests',async(req,res,next)=>{
  try{
    const cursor=String(req.query.before||'');
    if(cursor&&!/^[a-f0-9]{24}$/i.test(cursor))return res.status(400).send('Invalid request cursor');
    const filter={status:'pending',...(cursor?{_id:{$lt:cursor}}:{})};
    const batch=await require('../models/ModuleRequest').find(filter).sort({_id:-1}).limit(51).lean();
    const requests=batch.slice(0,50),nextBefore=batch.length>50?String(requests.at(-1)._id):null;
    renderPlatform(req,res,'modules/requests','Module Requests','Pending tenant module subscriptions for manual review.',{requests,nextBefore});
  }catch(e){next(e);}
});
router.post('/modules/requests/:id/reject',async(req,res,next)=>{
  try{await require('../services/moduleRequest.service').reject(req.params.id,req.platformUser,req.body);
    flash(req,'good','Module request rejected and audited.');res.redirect(303,'/platform/modules/requests');
  }catch(e){next(e);}
});
router.get('/operations/queue',async(req,res,next)=>{
  try{
    const status=await outbox.metrics();
    renderPlatform(req,res,'operations/queue','Background Operations','Durable, audited async notification processing and dead-letter recovery.',{status});
  }catch(e){next(e);}
});
router.post('/operations/queue/:id/retry',async(req,res,next)=>{
  try{
    await outbox.retryDead({id:req.params.id,actor:req.platformUser,reason:req.body.reason});
    flash(req,'good','Dead-letter event requeued and audited. Delivery is not yet confirmed.');
    res.redirect(303,'/platform/operations/queue');
  }catch(e){next(e);}
});
router.get('/modules',(req,res)=>renderPlatform(req,res,'modules/index','Module Catalogue','Active module definitions, permissions and list prices.',{modules}));
router.get('/appointments',async(req,res,next)=>{
  try{
    const page=await appointmentService.list(req.query);
    renderPlatform(req,res,'appointments/index','Appointments','Review and schedule onboarding requests.',{appointments:page.items,...page,moduleLabels:Object.fromEntries(modules.map(m=>[m.key,m.name]))});
  }catch(e){next(e);}
});
router.post('/appointments/:id/decision',async(req,res,next)=>{try{
 await appointmentService.decide(req.params.id,req.platformUser,req.body);
 flash(req,'good','Appointment decision saved and audited. Contact the requester through your configured communication channel.');res.redirect(303,'/platform/appointments');
}catch(error){next(error);}});
router.use((req,res)=>res.status(404).send('Page not found'));
module.exports=router;
