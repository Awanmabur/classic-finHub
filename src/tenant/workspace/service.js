'use strict';
const mongoose=require('mongoose');
const {models,ensure}=require('./models');
const {auditEventModel}=require('../models');
const {hasPermission}=require('../services/moduleAccess.service');
const {ROLES}=require('../../config/roles');
const {effectiveSubscription}=require('../../platform/services/commercial.service');
const {activeGrants}=require('../../platform/services/moduleSubscriptions.service');
const Tenant=require('../../platform/models/Tenant');
const {tenantDbNameFromSlug}=require('../../config/tenantDatabaseName');
const {permissionsFor}=require('../../config/roles');
const KIND_FIELDS=Object.freeze({
 landing_section:['name','description','status','order'],kyc_field:['name','type','required','description','status','options'],
 compliance_rule:['name','riskLevel','description','status'],integration:['name','type','description','status'],
 notification_rule:['name','channel','description','status'],data_job:['name','type'],backup_request:['name']
});
function fail(message,status=400){const error=new Error(message);error.status=status;return error;}
function oid(value){if(typeof value!=='string'||!/^[a-f0-9]{24}$/i.test(value))throw fail('Invalid workspace record');return new mongoose.Types.ObjectId(value);}
function tenantId(tenant){return oid(String(tenant?._id||''));}
function actorId(actor){return oid(String(actor?.id||actor?._id||''));}
function authorize(actor,manage=false){
 if(!actor||!hasPermission(actor,manage?'workspace.manage':'workspace.view')||(manage&&actor.role!=='Tenant Owner'))throw fail('Tenant owner access is required to configure this workspace.',403);
 actorId(actor);
}
function context(conn,tenant){
 let expected;try{expected=tenantDbNameFromSlug(tenant?.slug);}catch{throw fail('Tenant database context does not match this workspace.',403);}
 if(!tenant||conn?.name!==expected||tenant.dbName!==conn.name)throw fail('Tenant database context does not match this workspace.',403);
 tenantId(tenant);
}
// Service entry points re-read the account and tenant. Caller-provided roles or
// permissions cannot authorize settings access, including background callers.
async function access(conn,tenant,actor,{manage=false,session=null,fence=false}={}){
 context(conn,tenant);
 const tenantFilter={_id:tenantId(tenant),slug:tenant.slug,dbName:conn.name,status:{$in:['active','trial','past_due']},setupStatus:{$ne:'invited'}};
 const tenants=fence?Tenant.findOneAndUpdate(tenantFilter,{$inc:{__v:1}},{session,new:true}):Tenant.findOne(tenantFilter).session(session);
 const currentTenant=await tenants.lean();
 if(!currentTenant||(!effectiveSubscription(currentTenant)&&!activeGrants(currentTenant).length))throw fail('An active workspace subscription is required.',403);
 const people=require('../models').tenantUserModel(conn),filter={_id:actorId(actor),status:'active'};
 if(fence){const version=actor.authVersion??0;if(!Number.isSafeInteger(version)||version<0)throw fail('Workspace authorization changed. Sign in again.',403);filter.authVersion=version===0?{$in:[0,null]}:version;}
 const query=fence?people.findOneAndUpdate({...filter,role:'Tenant Owner'},{$inc:{__v:1}},{session,new:true}):people.findOne(filter).session(session);
 const person=await query.lean();
 if(!person)throw fail('Workspace account access has been revoked.',403);
 if(manage&&!person.mfaEnabledAt)throw fail('Authenticator enrollment is required to configure the workspace.',403);
 let trusted={id:String(person._id),name:person.name,role:person.role,permissions:permissionsFor(person.role),branchId:person.branchId||null,allowedModules:Array.isArray(person.allowedModules)?person.allowedModules:[],authVersion:person.authVersion||0};
 if(!fence&&!session)trusted=require('../services/branchView.service').withReadView(trusted,actor);
 authorize(trusted,manage);
 return {actor:trusted,tenant:currentTenant};
}
function plain(value,max=150,required=false){
 if(value===undefined||value===null)value='';
 if(typeof value!=='string')throw fail('Invalid workspace field');
 const result=value.trim();
 if(result.length>max||/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(result)||(required&&!result))throw fail('Complete the required fields within the displayed limits.');
 return result;
}
function choice(value,allowed,label){const result=plain(value,80,true);if(!allowed.includes(result))throw fail(`Choose a valid ${label}.`);return result;}
function revision(value){if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)return value;if(typeof value==='string'&&/^(0|[1-9]\d{0,8})$/.test(value))return Number(value);throw fail('Invalid form revision. Reload the page.',409);}
function fields(input,allowed){
 if(!input||typeof input!=='object'||Array.isArray(input))throw fail('Invalid workspace form');
 for(const key of Object.keys(input))if(!allowed.includes(key)&&!['_csrf','revision'].includes(key))throw fail('This field cannot be changed from workspace settings.');
}
function email(value){const v=plain(value,254);if(v&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))throw fail('Enter a valid owner email.');return v.toLowerCase();}
function phone(value){const v=plain(value,40);if(v&&!/^[+\d][\d ()-]{5,39}$/.test(v))throw fail('Enter a valid support phone.');return v;}
function defaults(tenant){return {tenantId:String(tenant._id),revision:0,
 profile:{name:tenant.name||'',legalName:'',owner:tenant.owner||'',ownerEmail:tenant.email||'',supportPhone:tenant.phone||'',country:'',timezone:'Africa/Kampala',defaultCurrency:'UGX'},
 landing:{headline:'',subtitle:'',services:[]},branding:{theme:'ClassicFin',primary:'#082c52',secondary:'#0d4f91',logoStatus:'Not uploaded',receiptNote:'',prefix:'CFH',template:'Standard receipt'}};}
function combine(tenant,saved){const base=defaults(tenant);return {...base,...saved,profile:{...base.profile,...saved?.profile},landing:{...base.landing,...saved?.landing},branding:{...base.branding,...saved?.branding}};}
function validateConfig(section,input){
 if(section==='profile'){
  fields(input,['name','legalName','owner','ownerEmail','supportPhone','country','timezone','defaultCurrency']);
  const timezone=plain(input.timezone,80,true);try{new Intl.DateTimeFormat('en',{timeZone:timezone}).format();}catch{throw fail('Choose a valid IANA timezone, for example Africa/Kampala.');}
  return {name:plain(input.name,150,true),legalName:plain(input.legalName,150),owner:plain(input.owner,150),ownerEmail:email(input.ownerEmail),supportPhone:phone(input.supportPhone),country:plain(input.country,80),timezone,defaultCurrency:choice(input.defaultCurrency,['UGX','KES','USD','SSP'],'default currency')};
 }
 if(section==='landing'){
  fields(input,['headline','subtitle','services']);
  const serviceText=plain(input.services,500),services=serviceText?serviceText.split(',').map(v=>plain(v,80,true)):[];
  if(services.length>12||new Set(services).size!==services.length)throw fail('Use up to 12 different services.');
  return {headline:plain(input.headline,200,true),subtitle:plain(input.subtitle,1000),services};
 }
 if(section==='branding'){
  fields(input,['theme','primary','secondary','logoStatus','receiptNote','prefix','template']);
  const primary=plain(input.primary,7,true),secondary=plain(input.secondary,7,true),prefix=plain(input.prefix,12,true);
  if(!/^#[a-fA-F0-9]{6}$/.test(primary)||!/^#[a-fA-F0-9]{6}$/.test(secondary))throw fail('Choose six-digit hexadecimal colors.');
  if(!/^[A-Z0-9-]{2,12}$/.test(prefix))throw fail('Receipt prefix must use 2–12 uppercase letters, numbers or hyphens.');
  return {theme:plain(input.theme,80,true),primary,secondary,logoStatus:plain(input.logoStatus,80),receiptNote:plain(input.receiptNote,500),prefix,template:plain(input.template,80,true)};
 }
 throw fail('Unknown workspace settings section',404);
}
function validateEntry(kind,input){
 if(!KIND_FIELDS[kind])throw fail('Unknown workspace record type',404);
 fields(input,KIND_FIELDS[kind]);
 const value={name:plain(input.name,150,true),description:'',type:'',status:'draft'};
 if(kind==='landing_section'){
  value.description=plain(input.description,2000,true);value.status=choice(input.status,['draft','published','hidden'],'section status');
  const order=String(input.order??'0');if(!/^\d{1,4}$/.test(order)||Number(order)>1000)throw fail('Section order must be between 0 and 1000.');value.order=Number(order);
 }else if(kind==='kyc_field'){
  value.type=choice(input.type,['Text','Number','Date','File','Select'],'field type');value.status=choice(input.status,['enabled','disabled'],'field status');
  if(!['true','false','on',undefined].includes(input.required))throw fail('Choose whether this field is required.');value.required=['true','on'].includes(input.required);
  value.description=plain(input.description,1000);const options=plain(input.options,500);
  value.options=options?options.split(',').map(v=>plain(v,80,true)):[];
  if(value.options.length>20||new Set(value.options).size!==value.options.length||(value.type==='Select'&&!value.options.length))throw fail('Select fields need up to 20 different choices.');
 }else if(kind==='compliance_rule'){
  value.riskLevel=choice(input.riskLevel,['Low','Medium','High','Critical'],'risk level');value.description=plain(input.description,2000,true);value.status=choice(input.status,['draft','enabled','disabled'],'rule status');
 }else if(kind==='integration'){
  value.type=choice(input.type,['Messaging','Payments','Forex','Email','Webhook','API','Accounting'],'integration type');value.status=choice(input.status,['draft','enabled','disabled'],'integration status');value.description=plain(input.description,1000);
  if(/-----BEGIN|(?:api[ _-]?key|token|secret|password)\s*[:=]|\bBearer\s+\S+/i.test(value.description))throw fail('Store integration descriptions only. Credentials belong in the platform secret configuration.');
 }else if(kind==='notification_rule'){
  value.channel=choice(input.channel,['Dashboard','Dashboard + Email','Dashboard + WhatsApp','Dashboard + SMS','Dashboard + Email + WhatsApp'],'notification channel');value.description=plain(input.description,2000,true);value.status=choice(input.status,['draft','enabled','disabled'],'rule status');
 }else if(kind==='data_job'){
  value.type=choice(input.type,['CSV','Excel','PDF export','Audit export','Full archive'],'data job type');
 }else{value.type='Platform backup request';value.status='rejected';value.result='Tenant-initiated backup execution is unavailable. Encrypted full-cluster backups are managed by the platform operator.';}
 return value;
}
async function transaction(conn,action){await ensure(conn);const session=await conn.startSession();try{let result;await session.withTransaction(async()=>{result=await action(session);});return result;}finally{await session.endSession();}}
async function audit(conn,session,tenant,actor,action,target,metadata={}){
 await auditEventModel(conn).create([{actorId:actorId(actor),targetId:target,action,metadata:{tenantId:String(tenant._id),...metadata}}],{session});
}
async function read(conn,tenant,actor){
 const trusted=await access(conn,tenant,actor);const saved=await models(conn).config.findOne({tenantId:tenantId(tenant)}).lean();return combine(trusted.tenant,saved);
}
async function save(conn,tenant,actor,section,input){
 await access(conn,tenant,actor,{manage:true});
 const patch=validateConfig(section,input),expected=revision(input.revision);
 try{return await transaction(conn,async session=>{
  const trusted=await access(conn,tenant,actor,{manage:true,session,fence:true});actor=trusted.actor;tenant=trusted.tenant;
  const {config}=models(conn),id=tenantId(tenant);let saved;
  const existing=await config.findOne({tenantId:id}).session(session);
  if(!existing){
   if(expected!==0)throw fail('Settings changed. Reload the page before saving.',409);
   const initial=defaults(tenant);saved=(await config.create([{...initial,[section]:patch,revision:1,updatedBy:actorId(actor)}],{session}))[0];
  }else{
   // Draft changes must preserve the last published landing snapshot.
   const changes={updatedBy:actorId(actor)};for(const [key,value] of Object.entries(patch))changes[`${section}.${key}`]=value;
   saved=await config.findOneAndUpdate({tenantId:id,revision:expected},{$set:changes,$inc:{revision:1}},{session,new:true,runValidators:true});
   if(!saved)throw fail('Settings changed. Reload the page before saving.',409);
  }
  await audit(conn,session,tenant,actor,`workspace.${section}.updated`,saved._id,{revision:saved.revision});return saved.toObject();
 });}catch(error){if(error.code===11000)throw fail('Settings changed. Reload the page before saving.',409);throw error;}
}
async function entries(conn,tenant,actor,kind,{archived=false}={}){
 await access(conn,tenant,actor);if(!KIND_FIELDS[kind])throw fail('Unknown workspace record type',404);
 return models(conn).entry.find({tenantId:tenantId(tenant),kind,...(!archived?{status:{$ne:'archived'}}:{})}).sort({order:1,createdAt:-1}).limit(200).lean();
}
async function writeEntry(conn,tenant,actor,kind,input,id=null){
 await access(conn,tenant,actor,{manage:true});
 const patch=validateEntry(kind,input),expected=revision(input.revision??0);
 return transaction(conn,async session=>{
  const trusted=await access(conn,tenant,actor,{manage:true,session,fence:true});actor=trusted.actor;tenant=trusted.tenant;
  const {entry}=models(conn),scope={tenantId:tenantId(tenant),kind};let saved;
  if(id){
   saved=await entry.findOneAndUpdate({...scope,_id:oid(id),revision:expected,status:{$ne:'archived'}},{$set:{...patch,updatedBy:actorId(actor)},$inc:{revision:1}},{session,new:true,runValidators:true});
   if(!saved)throw fail('Record not found or changed. Reload before saving.',409);
  }else{
   if(await entry.countDocuments(scope).session(session)>=200)throw fail('This workspace section has reached its 200-record limit.',409);
   saved=(await entry.create([{...scope,...patch,createdBy:actorId(actor),updatedBy:actorId(actor)}],{session}))[0];
  }
  await audit(conn,session,tenant,actor,`workspace.${kind}.${id?'updated':'created'}`,saved._id,{name:saved.name,revision:saved.revision});return saved.toObject();
 });
}
async function transition(conn,tenant,actor,kind,id,input){
 await access(conn,tenant,actor,{manage:true});
 if(!KIND_FIELDS[kind])throw fail('Unknown workspace record type',404);fields(input,['action']);
 const action=choice(input.action,['archive','restore','run'],'action'),expected=revision(input.revision);
 if(action==='run'&&kind!=='data_job')throw fail('This record does not have a job executor.');
 return transaction(conn,async session=>{
  const trusted=await access(conn,tenant,actor,{manage:true,session,fence:true});actor=trusted.actor;tenant=trusted.tenant;
  const filter={_id:oid(id),tenantId:tenantId(tenant),kind,revision:expected,...(action==='restore'?{status:'archived'}:action==='run'?{status:'draft'}:{status:{$ne:'archived'}})};
  const prior=await models(conn).entry.findOne(filter).session(session).lean();
  if(!prior)throw fail('Record not found or changed. Reload before saving.',409);
  const update={updatedBy:actorId(actor)};
  if(action==='archive'){update.status='archived';update.archivedStatus=prior.status;}
  if(action==='restore'){update.status=prior.archivedStatus||(kind==='kyc_field'?'disabled':'draft');update.archivedStatus=null;}
  if(action==='run'){update.status='rejected';update.result='No import worker is configured. No customer or financial records were changed. Use the available exports for existing data.';}
  const saved=await models(conn).entry.findOneAndUpdate(filter,{$set:update,$inc:{revision:1}},{session,new:true,runValidators:true});
  if(!saved)throw fail('Record not found or changed. Reload before saving.',409);
  await audit(conn,session,tenant,actor,`workspace.${kind}.${action==='run'?'rejected':action==='restore'?'restored':'archived'}`,saved._id,{name:saved.name,revision:saved.revision});return saved.toObject();
 });
}
async function publish(conn,tenant,actor,input){
 await access(conn,tenant,actor,{manage:true});
 fields(input,[]);const expected=revision(input.revision);
 return transaction(conn,async session=>{
  const trusted=await access(conn,tenant,actor,{manage:true,session,fence:true});actor=trusted.actor;tenant=trusted.tenant;
  const {config,entry}=models(conn),scope={tenantId:tenantId(tenant)};
  const current=await config.findOne({...scope,revision:expected}).session(session).lean();
  if(!current||!current.landing?.headline)throw fail('Save the landing headline, then reload before publishing.',409);
  const settings=combine(tenant,current),sections=await entry.find({...scope,kind:'landing_section',status:'published'}).sort({order:1,createdAt:1}).limit(200).session(session).lean();
  const snapshot={name:settings.profile.name,headline:settings.landing.headline,subtitle:settings.landing.subtitle,services:settings.landing.services,
   sections:sections.map(v=>({name:v.name,description:v.description,order:v.order})),primary:settings.branding.primary,secondary:settings.branding.secondary,supportPhone:settings.profile.supportPhone};
  const saved=await config.findOneAndUpdate({...scope,revision:expected},{$set:{'landing.published':snapshot,'landing.publishedAt':new Date(),'landing.publishedBy':actorId(actor),updatedBy:actorId(actor)},$inc:{revision:1}},{session,new:true,runValidators:true});
  if(!saved)throw fail('Settings changed. Reload before publishing.',409);
  await audit(conn,session,tenant,actor,'workspace.landing.published',saved._id,{revision:saved.revision,sections:sections.length});return saved.toObject();
 });
}
async function publicLanding(conn,tenant){
 context(conn,tenant);
 const config=await models(conn).config.findOne({tenantId:tenantId(tenant),'landing.publishedAt':{$ne:null}}).select('landing.published landing.publishedAt').lean();
 return config?.landing?.published?{...config.landing.published,publishedAt:config.landing.publishedAt}:null;
}
// Presentation data only. Never replace immutable financial references or infer
// provider verification from tenant branding or receipt preferences.
async function receiptIdentity(conn,tenant){
 context(conn,tenant);
 const saved=await models(conn).config.findOne({tenantId:tenantId(tenant)}).select('profile.name profile.supportPhone branding').lean();
 const config=combine(tenant,saved);
 return {name:config.profile.name,supportPhone:config.profile.supportPhone,prefix:config.branding.prefix,
  template:config.branding.template,footerNote:config.branding.receiptNote,
  primary:/^#[a-fA-F0-9]{6}$/.test(config.branding.primary)?config.branding.primary:'#082c52',
  secondary:/^#[a-fA-F0-9]{6}$/.test(config.branding.secondary)?config.branding.secondary:'#0d4f91'};
}
async function database(conn,tenant,actor){
 await access(conn,tenant,actor);const stats=await conn.db.stats();
 return {collections:Number(stats.collections||0),objects:Number(stats.objects||0),dataBytes:Number(stats.dataSize||0),storageBytes:Number(stats.storageSize||0),checkedAt:new Date(),
  backupConfigured:!!(process.env.BACKUP_SOURCE_URI&&process.env.BACKUP_KEY_FILE&&process.env.BACKUP_OUTPUT_DIR)};
}
async function health(conn,tenant,actor){
 const result=await database(conn,tenant,actor);
 await transaction(conn,async session=>{const trusted=await access(conn,tenant,actor,{manage:true,session,fence:true});return audit(conn,session,trusted.tenant,trusted.actor,'workspace.database.health_checked',tenantId(tenant),{collections:result.collections,objects:result.objects});});return result;
}
async function overview(conn,tenant,actor){
 return require('./operations').snapshot(conn,tenant,actor);
}
function roles(actor){authorize(actor);return Object.entries(ROLES).map(([name,permissions])=>({name,permissions:Array.from(permissions)}));}
async function subscription(conn,tenant,actor){const trusted=await access(conn,tenant,actor);tenant=trusted.tenant;return {subscription:tenant.subscription?JSON.parse(JSON.stringify(tenant.subscription)):null,effective:!!effectiveSubscription(tenant),grants:activeGrants(tenant),seatsReserved:tenant.seatsReserved||0,branchCount:tenant.branchCount||0};}
async function logs(conn,tenant,actor){await access(conn,tenant,actor);return auditEventModel(conn).find({'metadata.tenantId':String(tenant._id),action:/^workspace\./}).sort({createdAt:-1,_id:-1}).limit(200).lean();}
function csvCell(value){const text=String(value??'');return '"'+(/^[\s]*[=+@-]/.test(text)?"'"+text:text).replace(/"/g,'""')+'"';}
function auditCsv(rows){return [['Time','Action','Actor','Record','Revision'],...rows.map(v=>[new Date(v.createdAt).toISOString(),v.action,v.actorId,v.targetId,v.metadata?.revision??''])].map(r=>r.map(csvCell).join(',')).join('\r\n')+'\r\n';}
async function exportConfig(conn,tenant,actor){await access(conn,tenant,actor,{manage:true});return transaction(conn,async session=>{
 const trusted=await access(conn,tenant,actor,{manage:true,session,fence:true});
 const settings=combine(trusted.tenant,await models(conn).config.findOne({tenantId:tenantId(tenant)}).session(session).lean());
 const records=await models(conn).entry.find({tenantId:tenantId(tenant),kind:{$nin:['backup_request','data_job']}}).sort({kind:1,createdAt:1}).limit(1400).session(session).lean();
 await audit(conn,session,trusted.tenant,trusted.actor,'workspace.settings.exported',tenantId(tenant),{records:records.length});
 return {schemaVersion:1,exportedAt:new Date(),settings,records};});}
module.exports={fail,oid,authorize,access,plain,revision,validateConfig,validateEntry,defaults,read,save,entries,writeEntry,transition,publish,publicLanding,receiptIdentity,database,health,overview,roles,subscription,logs,auditCsv,exportConfig};
