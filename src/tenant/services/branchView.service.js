'use strict';
// A viewing branch narrows reads only. It never supplies an operating branch or
// travels through a posting authorization fence.
const {Types}=require('mongoose');
const WIDE_ROLES=new Set(['Tenant Owner','Auditor']);
const OID=/^[a-f0-9]{24}$/i;
function fail(message,status=403){return Object.assign(new Error(message),{status});}
function canViewBranches(actor){return WIDE_ROLES.has(actor?.role);}
function readScope(actor){
 if(!canViewBranches(actor)||actor.viewBranchId===undefined||actor.viewBranchId==='all')return {};
 if(!OID.test(String(actor.viewBranchId)))throw fail('The selected viewing branch is unavailable');
 return {branchId:new Types.ObjectId(String(actor.viewBranchId))};
}
function withReadView(trusted,original){
 if(canViewBranches(trusted)&&trusted.role===original?.role&&original.viewBranchId!==undefined){
  readScope(original);return {...trusted,viewBranchId:original.viewBranchId};
 }
 return trusted;
}
function withoutReadView(actor){const clean={...actor};delete clean.viewBranchId;return clean;}
function followRecord(req,record){
 if(!canViewBranches(req.user)||!req.session||!OID.test(String(record?.branchId||'')))return;
 const branchId=String(record.branchId),previous=req.session.viewBranchId;
 req.session.viewBranchId=branchId;
 if(previous!==undefined&&String(previous)!==branchId){
  const label=String(req.operationBranch?._id)===branchId?req.operationBranch.name:'the transaction branch';
  const prior=req.session.flash;
  req.session.flash={type:prior?.type||'good',message:(prior?.message?prior.message+' ':'')+'Viewing '+label+', where this record was saved.'};
 }
}
function mainBranch(branches){return branches.find(branch=>String(branch.code).toLowerCase()==='main')||branches.find(branch=>/\bmain\b/i.test(branch.name))||branches[0]||null;}
function safeReturnTo(value){
 if(typeof value!=='string'||!value.startsWith('/tenant/')||value.length>2000)return '/tenant/dashboard';
 let target;try{target=new URL(value,'https://classicfin.invalid');}catch{return '/tenant/dashboard';}
 if(target.origin!=='https://classicfin.invalid'||!target.pathname.startsWith('/tenant/'))return '/tenant/dashboard';
 target.searchParams.delete('cursor');target.searchParams.delete('page');
 return target.pathname+target.search;
}
async function context(req,res){
 delete req.user.viewBranchId;
 req.viewBranch=null;req.viewBranchId=null;
 const wide=canViewBranches(req.user);
 res.locals.canViewBranches=wide;res.locals.viewBranches=[];res.locals.viewBranch=null;res.locals.viewBranchId=null;
 res.locals.branchViewReturnTo=safeReturnTo(req.originalUrl||'/tenant/dashboard');
 if(!wide||!req.session)return;
 const branches=await require('../models').branchModel(req.tenantDb).find({status:'active'}).sort({_id:1}).select('_id name code currency').lean();
 const selected=req.session?.viewBranchId;
 const view=selected==='all'?null:branches.find(branch=>String(branch._id)===String(selected))||mainBranch(branches);
 const id=selected==='all'?'all':view?String(view._id):'all';
 if(req.session&&branches.length)req.session.viewBranchId=id;
 req.viewBranch=view;req.viewBranchId=id;
 if(['GET','HEAD'].includes(req.method))req.user.viewBranchId=id;
 res.locals.viewBranches=branches;res.locals.viewBranch=view;res.locals.viewBranchId=id;
}
async function change(req,res,next){try{
 if(!canViewBranches(req.user))throw fail('Branch viewing is limited to tenant-wide administrators and auditors');
 const selected=req.body?.viewBranchId;
 if(selected!=='all'){
  if(typeof selected!=='string'||!OID.test(selected))throw fail('Choose an active viewing branch',400);
  if(!await require('../models').branchModel(req.tenantDb).exists({_id:selected,status:'active'}))throw fail('The viewing branch is inactive or unavailable',404);
 }
 req.session.viewBranchId=selected;
 res.redirect(303,safeReturnTo(req.body.returnTo));
 }catch(error){next(error);}}
module.exports={canViewBranches,readScope,ownerScope:readScope,withReadView,withoutReadView,followRecord,mainBranch,safeReturnTo,context,change};
