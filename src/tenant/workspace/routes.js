'use strict';
const {Router}=require('express');
const requirePermission=require('../../middleware/requirePermission');
const service=require('./service');
const {models}=require('./models');
const {flash}=require('../../utils/view');
const {hasPermission,hasModuleForUser}=require('../services/moduleAccess.service');
const throttle=require('../../platform/services/actionThrottle.service').financial;
const field=(name,label,value='',extra={})=>({name,label,value,...extra});
const select=(name,label,value,options)=>field(name,label,value,{type:'select',options:options.map(v=>typeof v==='string'?{value:v,label:v}:{value:v[0],label:v[1]})});
const states=['draft','enabled','disabled'];
const entryPages={
 landing:{kind:'landing_section',title:'Landing page setup',subtitle:'Public tenant landing page content and published sections.',create:'Add section',modal:'Create landing section',section:'Landing section'},
 kyc:{kind:'kyc_field',title:'Customer/KYC setup',subtitle:'Customer verification field definitions and existing customer records.',create:'Add KYC field',modal:'Create KYC field',section:'KYC field'},
 compliance:{kind:'compliance_rule',title:'Compliance controls',subtitle:'KYC, risk, limits, watchlist, and approval control definitions.',create:'Create rule',modal:'Create compliance rule',section:'Compliance rule'},
 integrations:{kind:'integration',title:'Integrations & API',subtitle:'Integration descriptions and access to configured SMS capture.',create:'Add integration',modal:'Create integration',section:'Integration details'},
 'notification-rules':{kind:'notification_rule',title:'Notification rules',subtitle:'Alert definitions for owners, managers, tellers, and risk events.',create:'Create rule',modal:'Create notification rule',section:'Notification rule'},
 'import-export':{kind:'data_job',title:'Import / export data',subtitle:'Export existing workspace data and record onboarding notes.',create:'Add onboarding note',modal:'Create onboarding note',section:'Onboarding note'}
};
const pageNames={
 overview:['Tenant Workspace','Operating readiness, pending reviews, and business setup.'],profile:['Tenant profile','Business identity, operating setup, and account controls.'],
 branding:['Branding & receipts','Tenant colors, receipt template, and footer settings.'],roles:['Roles & permissions','Fixed server roles and their current permissions.'],
 database:['Tenant database','Current tenant database statistics and managed backup configuration.'],subscription:['Subscription & limits','Authoritative subscription terms, module grants, and usage limits.'],
 'landing-preview':['Landing preview','Preview current tenant content before publishing.'],'receipt-preview':['Receipt preview','Preview the configured receipt identity and wording.'],
 'customer-portal-preview':['Customer portal preview','Public customer support and receipt verification availability.'],audit:['Tenant audit activity','Recorded workspace configuration changes.']
};
function configForm(section,config,tenant={}){
 const value=config[section==='receipt'?'branding':section];let title,subtitle,group,fields,hidden=[];
 if(section==='profile'){
  title='Edit tenant profile';subtitle='Business identity, owner contact, and default currency.';group='Tenant identity';
  fields=[field('name','Business name',value.name,{required:true,max:150}),field('legalName','Legal name',value.legalName,{max:150}),field('owner','Owner / director',value.owner,{max:150}),field('ownerEmail','Owner email',value.ownerEmail,{type:'email',max:254}),field('supportPhone','Support phone',value.supportPhone,{max:40}),field('subdomain','Subdomain',tenant.slug||'',{displayOnly:true,hint:'The platform manages tenant routing.'}),field('customDomain','Custom domain','Not configured',{displayOnly:true,hint:'Domain registration is managed by the platform.'}),field('country','Country',value.country,{max:80}),field('timezone','Timezone',value.timezone,{required:true,max:80}),select('defaultCurrency','Default currency',value.defaultCurrency,[['UGX','UGX'],['USD','USD'],['SSP','SSP'],['KES','KSH']])];
 }else if(section==='landing'){
  title='Edit landing headline';subtitle='Public tenant landing page hero content.';group='Landing hero';
  fields=[field('headline','Headline',value.headline,{required:true,max:200}),field('subtitle','Subtitle',value.subtitle,{type:'textarea',max:1000,full:true}),field('services','Services, comma separated',value.services.join(', '),{max:500,full:true})];
 }else if(section==='receipt'){
  title='Edit receipt settings';subtitle='Receipt identity and saved footer wording.';group='Receipt settings';
  fields=[field('prefix','Receipt prefix',value.prefix,{required:true,max:12,pattern:'[A-Z0-9-]{2,12}'}),field('template','Template name',value.template,{required:true,max:80}),field('qrVerification','QR verification','Not enabled',{displayOnly:true}),field('duplicateProtection','Duplicate protection','Enabled: server reference uniqueness',{displayOnly:true}),field('receiptNote','Receipt note',value.receiptNote,{type:'textarea',max:500,full:true})];
  hidden=['theme','primary','secondary','logoStatus'].map(name=>({name,value:value[name]}));
 }else{
  title='Edit branding';subtitle='Tenant colors, theme, and receipt identity.';group='Brand and receipt identity';
  fields=[field('theme','Theme name',value.theme,{required:true,max:80}),field('primary','Primary color',value.primary,{type:'color',required:true}),field('secondary','Secondary color',value.secondary,{type:'color',required:true}),field('logoStatus','Logo status',value.logoStatus,{max:80}),field('receiptNote','Receipt footer note',value.receiptNote,{type:'textarea',max:500,full:true})];
  hidden=['prefix','template'].map(name=>({name,value:value[name]}));
 }
 return {title,subtitle,section:group,fields,hidden,action:`/tenant/workspace/${section==='receipt'?'branding':section}`,revision:config.revision};
}
function entryForm(spec,item={}){
 const state=item.status||'draft';let fields;
 if(spec.kind==='landing_section')fields=[field('name','Section title',item.name,{required:true,max:150}),select('status','Status',state,['draft','published','hidden']),field('description','Section body',item.description,{type:'textarea',full:true,required:true,max:2000}),field('order','Display order',item.order||0,{type:'number',min:0,max:1000})];
 if(spec.kind==='kyc_field')fields=[field('name','Field name',item.name,{required:true,max:150}),select('type','Field type',item.type||'Text',['Text','Number','Date','File','Select']),select('required','Required?',String(item.required||false),[['true','Yes'],['false','No']]),select('status','Status',item.status||'enabled',['enabled','disabled']),field('description','Usage note',item.description,{type:'textarea',full:true,max:1000}),field('options','Select choices, comma separated',(item.options||[]).join(', '),{max:500,full:true})];
 if(spec.kind==='compliance_rule')fields=[field('name','Rule name',item.name,{required:true,max:150}),select('riskLevel','Risk level',item.riskLevel||'Medium',['Low','Medium','High','Critical']),select('status','Status',state,states),field('description','Rule action',item.description,{type:'textarea',full:true,required:true,max:2000})];
 if(spec.kind==='integration')fields=[field('name','Integration name',item.name,{required:true,max:150}),select('type','Type',item.type||'Messaging',['Messaging','Payments','Forex','Email','Webhook','API','Accounting']),select('status','Status',state,[['draft','Draft'],['enabled','Configured'],['disabled','Disabled']]),field('description','Details',item.description,{type:'textarea',full:true,max:1000,hint:'Descriptions only. Store passwords, API keys, and tokens in the platform secret configuration.'})];
 if(spec.kind==='notification_rule')fields=[field('name','Rule name',item.name,{required:true,max:150}),select('channel','Channel',item.channel||'Dashboard',['Dashboard','Dashboard + Email','Dashboard + WhatsApp','Dashboard + SMS','Dashboard + Email + WhatsApp']),select('status','Status',state,states),field('description','Trigger condition',item.description,{type:'textarea',full:true,required:true,max:2000})];
 if(spec.kind==='data_job')fields=[field('name','Job name',item.name,{required:true,max:150}),select('type','Type',item.type||'CSV',['CSV','Excel','PDF export','Audit export','Full archive'])];
 return {title:item._id?spec.modal.replace(/^Create/,'Edit'):spec.modal,subtitle:spec.subtitle,section:spec.section,fields,
  action:`/tenant/workspace/entries/${spec.kind}${item._id?'/'+item._id:''}`,revision:item.revision||0};
}
function factory({renderTenant}){
 const router=Router();
 router.get('/theme.css',async(req,res,next)=>{try{
  const identity=await service.receiptIdentity(req.tenantDb,req.tenant);
  res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}).type('text/css').send(`:root,html[data-theme="light"],html[data-theme="dark"]{--primary:${identity.primary};--primary2:${identity.secondary}}`);
 }catch(error){next(error);}});
 router.use(requirePermission('workspace.view'));
 router.use((req,res,next)=>{res.setHeader('Cache-Control','private, no-store');next();});
 async function render(req,res,page,extra={}){
  const config=await service.read(req.tenantDb,req.tenant,req.user),spec=entryPages[page],names=spec?[spec.title,spec.subtitle]:pageNames[page];
  const data={page,title:names[0],subtitle:names[1],config,canManage:req.user.role==='Tenant Owner'&&hasPermission(req.user,'workspace.manage'),
   spec:spec||null,entries:[],form:null,canCustomers:hasModuleForUser(req.tenant,req.user,'customers')&&hasPermission(req.user,'customers.view'),canCustomerExport:hasModuleForUser(req.tenant,req.user,'customers')&&hasPermission(req.user,'customers.export'),
   canSms:hasModuleForUser(req.tenant,req.user,'sms_capture')&&hasModuleForUser(req.tenant,req.user,'mobile_money')&&hasPermission(req.user,'mobile_money.cash_in'),canNotifications:hasModuleForUser(req.tenant,req.user,'notifications')&&hasPermission(req.user,'notifications.view'),canCash:['mobile_money','money_transfer','banking','forex','expenses'].some(key=>hasModuleForUser(req.tenant,req.user,key)&&hasPermission(req.user,key+'.view'))&&hasPermission(req.user,'treasury.view'),canObserveFunds:hasPermission(req.user,'treasury.observe'),canReviewFunds:hasPermission(req.user,'treasury.review'),...extra};
  if(spec&&!extra.entries)data.entries=await service.entries(req.tenantDb,req.tenant,req.user,spec.kind,{archived:true});
  if(['profile','branding'].includes(page))data.form=configForm(page,config,req.tenant);
  if(page==='branding')data.receiptForm=configForm('receipt',config,req.tenant);
  if(page==='landing'){data.heroForm=configForm('landing',config,req.tenant);data.form=entryForm(spec);}
  else if(spec&&spec.kind!=='data_job')data.form=entryForm(spec);
  renderTenant(req,res,'workspace/index',names[0],names[1],data);
 }
 router.get('/',async(req,res,next)=>{try{await render(req,res,'overview',{summary:await service.overview(req.tenantDb,req.tenant,req.user)});}catch(error){next(error);}});
 for(const page of ['profile','branding',...Object.keys(entryPages),'landing-preview','receipt-preview','customer-portal-preview']){
  router.get('/'+page,async(req,res,next)=>{try{
  const extra=page==='landing-preview'?{sections:await service.entries(req.tenantDb,req.tenant,req.user,'landing_section')}:page==='profile'?{summary:await service.overview(req.tenantDb,req.tenant,req.user)}:{};
   await render(req,res,page,extra);
  }catch(error){next(error);}});
 }
 router.get('/roles',async(req,res,next)=>{try{await render(req,res,'roles',{roles:service.roles(req.user)});}catch(error){next(error);}});
 router.get('/database',async(req,res,next)=>{try{await render(req,res,'database',{stats:await service.database(req.tenantDb,req.tenant,req.user)});}catch(error){next(error);}});
 router.get('/subscription',async(req,res,next)=>{try{await render(req,res,'subscription',{terms:await service.subscription(req.tenantDb,req.tenant,req.user)});}catch(error){next(error);}});
 router.get('/audit',async(req,res,next)=>{try{await render(req,res,'audit',{logs:await service.logs(req.tenantDb,req.tenant,req.user)});}catch(error){next(error);}});
 router.get('/control',(req,res)=>res.redirect(303,'/tenant/workspace/profile'));
 router.get('/export.json',requirePermission('workspace.manage'),async(req,res,next)=>{try{
  const exported=await service.exportConfig(req.tenantDb,req.tenant,req.user);res.setHeader('Content-Disposition','attachment; filename="tenant-workspace-settings.json"');res.json(exported);
 }catch(error){next(error);}});
 router.get('/audit.csv',async(req,res,next)=>{try{
  const rows=await service.logs(req.tenantDb,req.tenant,req.user);res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="tenant-workspace-audit.csv"');res.send(service.auditCsv(rows));
 }catch(error){next(error);}});
 for(const [path,section,back] of [['/profile/edit','profile','profile'],['/branding/edit','branding','branding'],['/branding/receipt/edit','receipt','branding'],['/landing/headline/edit','landing','landing']])router.get(path,requirePermission('workspace.manage'),async(req,res,next)=>{try{
  const config=await service.read(req.tenantDb,req.tenant,req.user),form=configForm(section,config,req.tenant);
  renderTenant(req,res,'workspace/edit',form.title,form.subtitle,{form,back:'/tenant/workspace/'+back});
 }catch(error){next(error);}});
 router.get('/entries/:kind/new',requirePermission('workspace.manage'),async(req,res,next)=>{try{
  await service.access(req.tenantDb,req.tenant,req.user,{manage:true});
  const spec=Object.values(entryPages).find(v=>v.kind===req.params.kind);if(!spec)throw service.fail('Unknown workspace section',404);
  const form=entryForm(spec);renderTenant(req,res,'workspace/edit',form.title,spec.subtitle,{form,back:'/tenant/workspace/'+Object.keys(entryPages).find(k=>entryPages[k]===spec)});
 }catch(error){next(error);}});
 router.get('/entries/:kind/:id/edit',requirePermission('workspace.manage'),async(req,res,next)=>{try{
  await service.access(req.tenantDb,req.tenant,req.user,{manage:true});const spec=Object.values(entryPages).find(v=>v.kind===req.params.kind);if(!spec)throw service.fail('Unknown workspace section',404);
  const item=await models(req.tenantDb).entry.findOne({_id:service.oid(req.params.id),tenantId:service.oid(String(req.tenant._id)),kind:spec.kind,status:{$ne:'archived'}}).lean();
  if(!item)throw service.fail('Workspace record not found',404);
  const form=entryForm(spec,item);renderTenant(req,res,'workspace/edit',form.title,spec.subtitle,{form,back:'/tenant/workspace/'+Object.keys(entryPages).find(k=>entryPages[k]===spec)});
 }catch(error){next(error);}});
 for(const section of ['profile','landing','branding'])router.post('/'+section,requirePermission('workspace.manage'),throttle,async(req,res,next)=>{try{
  await service.save(req.tenantDb,req.tenant,req.user,section,req.body);flash(req,'good','Settings saved with an audit entry.');res.redirect(303,'/tenant/workspace/'+section);
 }catch(error){next(error);}});
 router.post('/landing/publish',requirePermission('workspace.manage'),throttle,async(req,res,next)=>{try{
  await service.publish(req.tenantDb,req.tenant,req.user,req.body);flash(req,'good','Landing page published. Later draft edits will not change the published page.');res.redirect(303,'/tenant/workspace/landing');
 }catch(error){next(error);}});
 function back(kind){return '/tenant/workspace/'+(Object.keys(entryPages).find(key=>entryPages[key].kind===kind)||'database');}
 for(const suffix of ['', '/:id'])router.post('/entries/:kind'+suffix,requirePermission('workspace.manage'),throttle,async(req,res,next)=>{try{
  if(!Object.values(entryPages).some(v=>v.kind===req.params.kind))throw service.fail('Unknown workspace section',404);
  await service.writeEntry(req.tenantDb,req.tenant,req.user,req.params.kind,req.body,req.params.id||null);flash(req,'good','Workspace record saved with an audit entry.');res.redirect(303,back(req.params.kind));
 }catch(error){next(error);}});
 router.post('/entries/:kind/:id/status',requirePermission('workspace.manage'),throttle,async(req,res,next)=>{try{
  await service.transition(req.tenantDb,req.tenant,req.user,req.params.kind,req.params.id,req.body);flash(req,'good','Workspace record updated with an audit entry.');res.redirect(303,back(req.params.kind));
 }catch(error){next(error);}});
 router.post('/database/health',requirePermission('workspace.manage'),throttle,async(req,res,next)=>{try{
  await service.health(req.tenantDb,req.tenant,req.user);flash(req,'good','Database health check completed and recorded.');res.redirect(303,'/tenant/workspace/database');
 }catch(error){next(error);}});
 return router;
}
factory.entryForm=entryForm;factory.configForm=configForm;factory.entryPages=entryPages;factory.pageNames=pageNames;
module.exports=factory;
