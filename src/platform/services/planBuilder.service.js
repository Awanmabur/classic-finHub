'use strict';
const mongoose=require('mongoose');
const PlanDraft=require('../models/PlanDraft');
const PlanVersion=require('../models/PlanVersion');
const Audit=require('../models/PlatformAuditLog');
const commercial=require('./commercial.service');
const {modules}=require('../../data/store');
const CODE=/^[a-z][a-z0-9_]{1,40}$/;
const LIMIT_KEYS=['users','branches','transactionsPerMonth','smsPerMonth','storageMb'];
function fail(message,status=400){return Object.assign(new Error(message),{status});}
function authorize(actor){if(!actor?.id||!actor.permissions?.includes('*'))throw fail('Super Admin access is required',403);}
function text(value){return typeof value==='string'?value.trim():'';}
function money(value,label){
  const raw=text(value);
  if(!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(raw))throw fail(`${label} must be a non-negative amount with at most two decimal places`);
  const [major,minor='']=raw.split('.');
  const result=Number(major)*100+Number(minor.padEnd(2,'0'));
  if(!Number.isSafeInteger(result)||result>100000000)throw fail(`${label} exceeds the supported price limit`);
  return result;
}
function integer(value,label,min=0,max=100000000){
  if(typeof value!=='string'||!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<min||Number(value)>max)
    throw fail(`${label} must be a whole number between ${min} and ${max}`);
  return Number(value);
}
function parseForm(input,code){
  const entryMode=text(input.entryMode)||'manual';
  const selected=typeof input.modules==='string'?[input.modules]:Array.isArray(input.modules)?input.modules:[];
  const terms={code:code||text(input.code),name:text(input.name),description:text(input.description),currency:'USD',
    priceMonthlyMinor:money(input.priceMonthly,'Monthly price'),priceYearlyMinor:money(input.priceYearly,'Yearly price'),
    trialMonths:integer(input.trialMonths,'Trial months',0,3),modules:selected,
    limits:Object.fromEntries(LIMIT_KEYS.map(key=>[key,integer(input['limit_'+key],key,['users','branches'].includes(key)?1:0)])),
    entryMode,availableForNewTenants:input.availableForNewTenants==='true'||input.availableForNewTenants===true};
  if(entryMode==='sms_assisted')terms.manualPlanCode=text(input.manualPlanCode);
  const live=new Set(modules.filter(module=>module.runtimeStatus!=='disabled').map(module=>module.key));
  if(selected.some(key=>typeof key!=='string'||!live.has(key)))throw fail('Choose only available modules from the catalogue');
  return commercial.validateNewVersion(terms);
}
function termsFromVersion(version){
  return {code:version.code,name:version.name,description:version.description,currency:version.currency,
    priceMonthlyMinor:version.priceMonthlyMinor,priceYearlyMinor:version.priceYearlyMinor,trialMonths:version.trialMonths,
    modules:[...version.modules],limits:{...version.limits},entryMode:version.entryMode||'manual',
    availableForNewTenants:version.availableForNewTenants!==false,
    ...(version.entryMode==='sms_assisted'?{manualPlanCode:version.manualPlanCode}:{} )};
}
function blankTerms(){return {code:'',name:'',description:'',currency:'USD',priceMonthlyMinor:0,priceYearlyMinor:0,trialMonths:1,
  modules:[],limits:{users:3,branches:1,transactionsPerMonth:1000,smsPerMonth:0,storageMb:500},entryMode:'manual',availableForNewTenants:true};}
function formValues(terms){return {...terms,priceMonthly:(terms.priceMonthlyMinor/100).toFixed(2),priceYearly:(terms.priceYearlyMinor/100).toFixed(2),
  ...Object.fromEntries(LIMIT_KEYS.map(key=>['limit_'+key,String(terms.limits[key])]))};}
async function editor(code){
  if(!code)return {values:formValues(blankTerms()),revision:0,baseVersion:0,existing:false};
  if(!CODE.test(code))throw fail('Plan not found',404);
  const [draft,current]=await Promise.all([PlanDraft.findOne({code}).lean(),commercial.latestPublished(code)]);
  if(draft)return {values:formValues(draft.terms),revision:draft.revision,baseVersion:draft.baseVersion,existing:true,
    unpublished:draft.revision!==draft.publishedDraftRevision,latestVersion:current?.version||0};
  if(!current)throw fail('Plan not found',404);
  return {values:formValues(termsFromVersion(current)),revision:0,baseVersion:current.version,existing:true,unpublished:false,latestVersion:current.version};
}
async function list(){
  const [published,drafts]=await Promise.all([commercial.publishedPlans(),PlanDraft.find({}).sort({updatedAt:-1}).lean()]);
  const latest=new Map();for(const version of published)if(!latest.has(version.code))latest.set(version.code,version);
  return {published,latest:[...latest.values()],drafts};
}
async function saveDraft(actor,input,code){
  authorize(actor);
  const terms=parseForm(input,code);
  const revision=integer(input.revision||'0','Draft revision',0);
  const expectedBase=integer(input.baseVersion||'0','Published version',0);
  const current=await commercial.latestPublished(terms.code);
  if((current?.version||0)!==expectedBase)throw fail('Published terms changed. Open the latest plan before saving a new draft.',409);
  const session=await mongoose.startSession();let saved;
  try{await session.withTransaction(async()=>{
    if(revision===0){
      [saved]=await PlanDraft.create([{code:terms.code,terms,baseVersion:expectedBase,revision:1,createdBy:String(actor.id),updatedBy:String(actor.id)}],{session});
    }else{
      saved=await PlanDraft.findOneAndUpdate({code:terms.code,revision,baseVersion:expectedBase},{$set:{terms,updatedBy:String(actor.id)},$inc:{revision:1}},{new:true,session,runValidators:true});
      if(!saved)throw fail('This draft changed in another session. Refresh before saving.',409);
    }
    await Audit.create([{actorId:String(actor.id),actorName:String(actor.name||''),action:'catalog.plan_draft_saved',moduleKey:'billing',recordId:terms.code,
      after:{revision:saved.revision,baseVersion:expectedBase,name:terms.name,entryMode:terms.entryMode}}],{session});
  });return saved;
  }catch(error){if(error.code===11000)throw fail('A draft with this plan code already exists. Open it to continue editing.',409);throw error;}
  finally{await session.endSession();}
}
async function publishDraft(actor,code,input){
  authorize(actor);if(!CODE.test(code))throw fail('Plan not found',404);
  const revision=integer(input.revision,'Draft revision',1);
  const reason=text(input.reason);if(reason.length<20||reason.length>600)throw fail('Explain this publication in 20–600 characters');
  const session=await mongoose.startSession();let result;
  try{await session.withTransaction(async()=>{
    await commercial.fencePublication(session);
    const draft=await PlanDraft.findOne({code,revision}).session(session).lean();
    if(!draft)throw fail('Draft changed or is unavailable. Refresh before publishing.',409);
    if(draft.publishedDraftRevision===revision)throw fail('This draft revision has already been published. Save changes before publishing another version.',409);
    const current=await PlanVersion.findOne({code,status:'published'}).sort({version:-1}).session(session).lean();
    if((current?.version||0)!==draft.baseVersion)throw fail('Published terms changed. Review the latest version before publishing.',409);
    const terms=commercial.validateNewVersion(draft.terms);
    const smsTerms=await commercial.validateSmsPricing(terms,{session});
    const version=draft.baseVersion+1,document={...terms,...smsTerms,version};
    const [published]=await PlanVersion.create([{...document,sourceHash:commercial.checksum(document),status:'published',publishedAt:new Date()}],{session});
    const updated=await PlanDraft.updateOne({code,revision,baseVersion:draft.baseVersion},{$set:{baseVersion:version,publishedDraftRevision:revision,updatedBy:String(actor.id)}},{session});
    if(updated.modifiedCount!==1)throw fail('Draft changed while publishing. Refresh and retry.',409);
    await Audit.create([{actorId:String(actor.id),actorName:String(actor.name||''),action:'catalog.plan_version_published',moduleKey:'billing',recordId:code,
      after:{version,sourceHash:published.sourceHash,reason,entryMode:terms.entryMode,manualPlanCode:terms.manualPlanCode||null,manualPlanVersion:smsTerms.manualPlanVersion||null}}],{session});
    result=published;
  });return result;
  }catch(error){if(error.code===11000)throw fail('This plan was published concurrently. Review the latest version before retrying.',409);throw error;}
  finally{await session.endSession();}
}
module.exports={parseForm,money,formValues,editor,list,saveDraft,publishDraft,termsFromVersion,blankTerms};
