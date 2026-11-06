'use strict';
const {Router}=require('express');
const {randomUUID}=require('node:crypto');
const requireModule=require('../../middleware/requireModule');
const requirePermission=require('../../middleware/requirePermission');
const {flash}=require('../../utils/view');
const {hasPermission,hasModuleForUser}=require('../services/moduleAccess.service');
const service=require('./service');
const {csvCell}=require('../services/mobileMoney.service');
function drain(res){return new Promise(resolve=>{const done=()=>{res.off('drain',done);res.off('close',done);resolve();};res.once('drain',done);res.once('close',done);});}
module.exports=function customerAccountsRoutes({renderTenant}){
 const router=Router();
 const guard=(moduleKey,permission)=>[requireModule(moduleKey),requirePermission(permission)];
 const wrap=handler=>(req,res,next)=>Promise.resolve(handler(req,res)).catch(next);
 function common(req){return {canExportCustomer:hasPermission(req.user,'customers.export')&&hasModuleForUser(req.tenant,req.user,'customers'),canCreateCustomer:hasPermission(req.user,'customers.create')&&hasModuleForUser(req.tenant,req.user,'customers'),canManageCustomer:hasPermission(req.user,'customers.manage')&&hasModuleForUser(req.tenant,req.user,'customers'),canManageAccount:hasPermission(req.user,'accounts.manage')&&hasModuleForUser(req.tenant,req.user,'accounts'),canViewAccounts:hasPermission(req.user,'accounts.view')&&hasModuleForUser(req.tenant,req.user,'accounts'),canBank:hasPermission(req.user,'banking.requests.create')&&hasModuleForUser(req.tenant,req.user,'banking'),formatMinor:service.formatMinor,idempotencyKey:randomUUID(),formRecord:null};}
 async function customers(req,res,open=false){const records=await service.customerList(req.tenantDb,req.tenant,req.user,req.query);renderTenant(req,res,'customer-accounts/customers','Customers','Customer directory, linked accounts, and customer logbook.',{...common(req),records,autoOpen:open,formKind:'customer'});}
 router.get('/customers',...guard('customers','customers.view'),wrap((req,res)=>customers(req,res)));
 router.get('/customers/new',...guard('customers','customers.create'),wrap((req,res)=>customers(req,res,true)));
 router.get('/customers/logbook',...guard('customers','customers.view'),wrap(async(req,res)=>{const records=await service.logbook(req.tenantDb,req.tenant,req.user,req.query);renderTenant(req,res,'customer-accounts/logbook','Customer logbook','Customer-related transactions from recorded phones and linked accounts.',{...common(req),records});}));
 router.get('/customers/export.csv',...guard('customers','customers.export'),wrap(async(req,res)=>{
  const cursor=await service.customerExport(req.tenantDb,req.tenant,req.user,req.query),fields=service.EXPORT_FIELDS;
  res.type('text/csv; charset=utf-8');res.set('Content-Disposition','attachment; filename="customers.csv"');res.set('Cache-Control','private, no-store');
  res.write('\uFEFF'+fields.map(csvCell).join(',')+'\r\n');
  try{for await(const row of cursor){if(res.destroyed)break;if(!res.write(fields.map(k=>csvCell(row[k] instanceof Date?row[k].toISOString():row[k])).join(',')+'\r\n'))await drain(res);}}
  finally{await cursor.close();}res.end();
 }));
 router.get('/customers/:id',...guard('customers','customers.view'),wrap(async(req,res)=>{const record=await service.customerDetail(req.tenantDb,req.tenant,req.user,req.params.id);renderTenant(req,res,'customer-accounts/customer','Customer profile','Customer identity, next of kin, address and linked activity.',{...common(req),record,formRecord:record,formKind:'customer'});}));
 router.post('/customers',...guard('customers','customers.create'),wrap(async(req,res)=>{const result=await service.customerCreate(req.tenantDb,req.tenant,req.user,req.body);flash(req,'good',result.duplicate?'Customer already created.':'Customer created.');res.redirect(303,`/tenant/customers/${result.record._id}`);}));
 router.post('/customers/:id/update',...guard('customers','customers.manage'),wrap(async(req,res)=>{await service.customerUpdate(req.tenantDb,req.tenant,req.user,req.params.id,req.body);flash(req,'good','Customer updated.');res.redirect(303,`/tenant/customers/${req.params.id}`);}));
 router.post('/customers/:id/archive',...guard('customers','customers.manage'),wrap(async(req,res)=>{await service.customerArchive(req.tenantDb,req.tenant,req.user,req.params.id,req.body);flash(req,'good','Customer archived. The profile and activity remain in the logbook.');res.redirect(303,'/tenant/customers?status=archived');}));
 async function accounts(req,res,mode='directory',open=false){const records=await service.accountList(req.tenantDb,req.tenant,req.user,req.query),data={...common(req),records,mode,autoOpen:open,formKind:'account',customerChoices:[]};if(data.canManageAccount&&req.operationBranch)data.customerChoices=await service.customerChoices(req.tenantDb,req.tenant,req.user);renderTenant(req,res,'customer-accounts/accounts',mode==='balances'?'Account balances':'Accounts','Account directory, balances, and account movements.',data);}
 router.get('/accounts',...guard('accounts','accounts.view'),wrap((req,res)=>accounts(req,res)));
 router.get('/accounts/new',...guard('accounts','accounts.manage'),wrap((req,res)=>accounts(req,res,'directory',true)));
 router.get('/accounts/customer-options',...guard('accounts','accounts.manage'),wrap(async(req,res)=>res.json({items:await service.customerChoices(req.tenantDb,req.tenant,req.user,req.query)})));
 router.get('/accounts/balances',...guard('accounts','accounts.view'),wrap((req,res)=>accounts(req,res,'balances')));
 router.get('/accounts/movements',...guard('accounts','accounts.view'),wrap(async(req,res)=>{const records=await service.movements(req.tenantDb,req.tenant,req.user,req.query);renderTenant(req,res,'customer-accounts/movements','Account movements','Deposits, withdrawals, and transfers recorded in the internal ledger.',{...common(req),records});}));
 router.get('/accounts/:id',...guard('accounts','accounts.view'),wrap(async(req,res)=>{const record=await service.accountDetail(req.tenantDb,req.tenant,req.user,req.params.id);renderTenant(req,res,'customer-accounts/account','Account details','Account owner, internal ledger balance and account intelligence.',{...common(req),record,formRecord:record,formKind:'account',customerChoices:[]});}));
 router.post('/accounts',...guard('accounts','accounts.manage'),wrap(async(req,res)=>{const result=await service.accountCreate(req.tenantDb,req.tenant,req.user,req.body);flash(req,'good',result.duplicate?'Account already created.':'Account created. Opening ledger balance is zero until a verified operation is posted.');res.redirect(303,`/tenant/accounts/${result.record._id}`);}));
 router.post('/accounts/:id/update',...guard('accounts','accounts.manage'),wrap(async(req,res)=>{await service.accountUpdate(req.tenantDb,req.tenant,req.user,req.params.id,req.body);flash(req,'good','Account details updated.');res.redirect(303,`/tenant/accounts/${req.params.id}`);}));
 return router;
};
