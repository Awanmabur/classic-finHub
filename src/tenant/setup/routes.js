'use strict';
// A single owner-facing start screen that calls established business services.
// No new shadow ledger, fake balance, permissions bypass, or setup-only data.
const {Router}=require('express');
const {randomUUID}=require('node:crypto');
const requirePermission=require('../../middleware/requirePermission');
const throttle=require('../../platform/services/actionThrottle.service').financial;
const {flash}=require('../../utils/view');
const branchService=require('../services/branch.service');
const staffService=require('../services/staff.service');
const staffPolicy=require('../services/staffPolicy');
const access=require('../services/moduleAccess.service');
const treasury=require('../treasury/service');
const {staffInviteModel,tenantUserModel}=require('../models');
const {models:fundModels}=require('../treasury/models');
const {currencyCodes}=require('../../config/currencies');
const networkTariffs=require('../pricing/networkTariffs');

function invalid(message,status=400){const e=new Error(message);e.status=status;return e;}
function exact(input,allowed){
 if(!input||typeof input!=='object'||Array.isArray(input)||
    Object.keys(input).some(k=>!allowed.includes(k)&&k!=='_csrf'))
    throw invalid('Please use the setup fields shown on this page.');
}
function owner(req){
 if(req.user?.role!=='Tenant Owner')throw invalid('Only the business owner can run quick setup.',403);
}
const tz=['Africa/Juba','Africa/Kampala','Africa/Nairobi','Africa/Dar_es_Salaam','Africa/Kigali','Africa/Cairo','UTC'];
const kindLabel=Object.freeze({cash:'Cash drawer',wallet:'Mobile money float',bank:'Bank account',
  forex_stock:'Forex stock',transfer_clearing:'Transfer clearing'});
function accountKinds(tenant,actor){
 const result=['cash','bank'];
 if(access.hasModuleForUser(tenant,actor,'mobile_money'))result.push('wallet');
 if(access.hasModuleForUser(tenant,actor,'forex'))result.push('forex_stock');
 if(access.hasModuleForUser(tenant,actor,'money_transfer'))result.push('transfer_clearing');
 return result;
}
function branchInput(body){
 exact(body,['name','currency','timeZone']);
 const name=String(body.name||'Main branch').trim()||'Main branch';
 const currency=String(body.currency||'');
 const timeZone=String(body.timeZone||'');
 if(!currencyCodes.includes(currency)||!tz.includes(timeZone))throw invalid('Choose the operating currency and local timezone.');
 return {name,currency,timeZone,currencies:[currency]};
}
function inviteInput(body,tenant,roles,branches){
 exact(body,['name','email','role','branchId']);
 const role=String(body.role||''),branchId=String(body.branchId||'');
 if(!roles.includes(role))throw invalid('Choose a permitted staff role.',403);
 if(!branches.some(b=>String(b._id)===branchId))throw invalid('Choose an active branch for this staff member.');
 // A role receives only modules already entitled by the tenant and permitted
 // by that role. No admin needs to tick a long list to make basic access work.
 const allowedModules=access.assignableModules(tenant,role);
 return {name:body.name,email:body.email,role,branchId,allowedModules};
}
function moneyInput(body,tenant,actor,branches){
 exact(body,['kind','branchId','currency','network','operatorId','accountReference']);
 const kind=String(body.kind||''),branchId=String(body.branchId||'');
 const branch=branches.find(b=>String(b._id)===branchId);
 if(!branch)throw invalid('Choose an active branch.');
 if(!accountKinds(tenant,actor).includes(kind))throw invalid('The selected money account is unavailable on your plan.',403);
 const network=kind==='wallet'?String(body.network||''):'';
 if(kind==='wallet'&&!treasury.NETWORKS.includes(network))throw invalid('Choose the mobile-money provider.');
 const currency=kind==='wallet'&&networkTariffs.NETWORKS[network]?.currency||String(body.currency||'');
 if(!currencyCodes.includes(currency)||!(branch.currencies||[branch.currency]).includes(currency))
  throw invalid('Use a currency enabled for the selected branch.');
 // Cash custody always belongs to a real operator, the owner by default.
 const operatorId=kind==='cash'?String(body.operatorId||actor.id):String(body.operatorId||'');
 const names={cash:'Cash drawer',wallet:network+' float',bank:'Bank balance',
    forex_stock:'Forex stock',transfer_clearing:'Transfer clearing'};
 return {branchId,account:{kind,currency,network,operatorId,
   accountReference:String(body.accountReference||''),name:names[kind]+' '+currency,
   isDefault:true}};
}
function handleSetupError(req,res,next,error){
 if([400,403,409,422].includes(error?.status)){
  flash(req,'bad',error.message);
  return res.redirect(303,'/tenant/setup');
 }
 next(error);
}
module.exports=function quickSetupRoutes({renderTenant}){
 const router=Router();
 router.use((req,res,next)=>{res.set('Cache-Control','private, no-store');next();});
 router.get('/',requirePermission('dashboard.view'),async(req,res,next)=>{
  try{
   owner(req);
   const branches=(await branchService.list(req.tenant)).filter(x=>x.status==='active');
   const [users,invites,accounts,staff]=await Promise.all([
    tenantUserModel(req.tenantDb).countDocuments({status:'active',role:{$ne:'Tenant Owner'}}).maxTimeMS(3000),
    staffInviteModel(req.tenantDb).countDocuments({status:'pending',expiresAt:{$gt:new Date()}}).maxTimeMS(3000),
    fundModels(req.tenantDb).account.find({tenantId:req.tenant._id,status:{$ne:'archived'}})
      .select('_id name kind currency network branchId openingBalanceMinor openingApprovedAt reconciliationState status')
      .sort({createdAt:-1,_id:-1}).limit(80).lean().maxTimeMS(3000),
    tenantUserModel(req.tenantDb).find({status:'active',role:{$ne:'Tenant Owner'}})
      .select('_id name role branchId').sort({name:1}).limit(80).lean().maxTimeMS(3000)
   ]);
   const ready=accounts.filter(x=>x.status==='active'&&x.openingBalanceMinor!=null&&
     x.openingApprovedAt&&x.reconciliationState==='matched');
   const kinds=accountKinds(req.tenant,req.user);
   renderTenant(req,res,'setup/index','Start using ClassicFin Hub',
     'Set up your branch, staff and actual money accounts in one place.',{
       branches,users,invites,accounts,staff,readyCount:ready.length,
       roles:staffPolicy.managedRoles(req.user),kinds,
       currencyCodes,networks:treasury.NETWORKS,networkCurrencies:networkTariffs.NETWORKS,
       timeZones:tz,kindLabel
     });
  }catch(e){next(e);}
 });
 router.post('/branch',requirePermission('branches.manage'),throttle,async(req,res,next)=>{
  try{
   owner(req);const form=branchInput(req.body);
   const existing=(await branchService.list(req.tenant)).filter(x=>x.status==='active');
   if(existing.length)throw invalid('Your branch is already set up. Use Branches to add more locations.',409);
   await branchService.create(req.tenant,req.user,form);
   flash(req,'good','Branch ready. You can invite staff and add actual cash or float accounts.');
   res.redirect(303,'/tenant/setup');
  }catch(e){handleSetupError(req,res,next,e);}
 });
 router.post('/staff',requirePermission('users.manage_branch'),throttle,async(req,res,next)=>{
  try{
   owner(req);
   const branches=(await branchService.list(req.tenant)).filter(x=>x.status==='active');
   const values=inviteInput(req.body,req.tenant,staffPolicy.managedRoles(req.user),branches);
   const inviteUrl=await staffService.issueInvite(req.tenant,req.user,values);
   // The employee must privately accept the link and set their own password.
   // No additional human administrator decision is involved.
   renderTenant(req,res,'users/invite','Invite sent','Employee can activate access from the private link.',{
     inviteUrl,inviteQueued:require('../../config/inviteMail').configured()
   });
  }catch(e){handleSetupError(req,res,next,e);}
 });
 router.post('/account',requirePermission('treasury.manage'),throttle,async(req,res,next)=>{
  try{
   owner(req);
   const branches=(await branchService.list(req.tenant)).filter(x=>x.status==='active');
   const values=moneyInput(req.body,req.tenant,req.user,branches);
   const created=await treasury.createAccount(req.tenantDb,req.tenant,req.user,
     values.account,{configurationBranchId:values.branchId});
   flash(req,'good','Account created. The opening balance is not yet established. Record the actual count or provider statement next.');
   res.redirect(303,'/tenant/treasury/accounts/'+created._id);
  }catch(e){handleSetupError(req,res,next,e);}
 });
 return router;
};

// Pure validation helpers are also exercised by the release test suite.
module.exports.validation={branchInput,inviteInput,moneyInput,accountKinds};
