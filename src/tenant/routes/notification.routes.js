'use strict';
const {Router}=require('express');
const {randomUUID}=require('node:crypto');
const requirePermission=require('../../middleware/requirePermission');
const throttle=require('../../platform/services/actionThrottle.service').notifications;
const service=require('../services/notification.service');
const {flash}=require('../../utils/view');
module.exports=function notificationRoutes({renderTenant}){
 const router=Router();
 router.get('/',requirePermission('notifications.view'),async(req,res,next)=>{try{
  const sender=service.canSend(req.tenant,req.user);
  const manager=service.canManage(req.tenant,req.user);
  const [inbox,prefs,templates,recipients,logs]=await Promise.all([
   service.inbox(req.tenantDb,req.tenant,req.user,{cursor:req.query.cursor}),
   service.preference(req.tenantDb,req.tenant,req.user),
   sender?service.templates(req.tenantDb,req.tenant,req.user):[],
   sender?service.recipients(req.tenantDb,req.tenant,req.user,req.query.search||''):[],
   ['Tenant Owner','Branch Manager'].includes(req.user.role)?service.logs(req.tenantDb,req.tenant,req.user):[]
  ]);
  renderTenant(req,res,'notifications/index','Notifications',
   'Private staff inbox, controlled templates and verified delivery state. Provider acceptance is not proof of delivery.',
   {inbox,prefs,templates,recipients,logs,canManage:manager,canSend:sender,search:String(req.query.search||'').slice(0,80),requestKey:randomUUID()});
 }catch(e){next(e);}});
 router.post('/preferences',requirePermission('notifications.view'),throttle,async(req,res,next)=>{try{
  await service.setPreference(req.tenantDb,req.tenant,req.user,req.body);
  flash(req,'good','Delivery preference updated. In-app records remain available in your inbox.');res.redirect(303,'/tenant/notifications');
 }catch(e){next(e);}});
 router.post('/templates',requirePermission('notifications.manage_templates'),throttle,async(req,res,next)=>{try{
  await service.publish(req.tenantDb,req.tenant,req.user,req.body);
  flash(req,'good','Notification template version published with an audit event.');res.redirect(303,'/tenant/notifications');
 }catch(e){next(e);}});
 router.post('/templates/:code/retire',requirePermission('notifications.manage_templates'),throttle,async(req,res,next)=>{try{
  await service.retire(req.tenantDb,req.tenant,req.user,req.params.code);
  flash(req,'good','Template retired; existing notification records remain unchanged.');res.redirect(303,'/tenant/notifications');
 }catch(e){next(e);}});
 router.post('/send',requirePermission('notifications.send'),throttle,async(req,res,next)=>{try{
  const sent=await service.send(req.tenantDb,req.tenant,req.user,req.body);
  flash(req,'good',sent.duplicate?'Existing identical message kept; no duplicate sent.':'In-app message recorded. Any requested email is pending provider acceptance.');
  res.redirect(303,'/tenant/notifications');
 }catch(e){next(e);}});
 router.post('/:id/requeue',requirePermission('notifications.manage_templates'),throttle,async(req,res,next)=>{try{
  await service.requeue(req.tenantDb,req.tenant,req.user,req.params.id,req.body.reason);
  flash(req,'good','Email delivery requeued with an audit entry. No delivery is implied.');res.redirect(303,'/tenant/notifications');
 }catch(e){next(e);}});
 router.get('/:id',requirePermission('notifications.view'),async(req,res,next)=>{try{
  const message=await service.detail(req.tenantDb,req.tenant,req.user,req.params.id);
  renderTenant(req,res,'notifications/detail','Notification Detail','Private staff message. Email acceptance does not imply delivery.',{message});
 }catch(e){next(e);}});
 router.post('/:id/read',requirePermission('notifications.view'),throttle,async(req,res,next)=>{try{
  await service.markRead(req.tenantDb,req.tenant,req.user,req.params.id);
  res.redirect(303,`/tenant/notifications/${req.params.id}`);
 }catch(e){next(e);}});
 return router;
};
