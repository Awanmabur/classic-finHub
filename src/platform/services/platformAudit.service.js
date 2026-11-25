'use strict';
const PlatformAuditLog = require('../models/PlatformAuditLog');
async function log(actor, action, moduleKey, recordId) {
  if (!actor?.id || typeof action !== 'string' || !action) throw new Error('Platform audit log requires a verified actor and action');
  return PlatformAuditLog.create({actorId:String(actor.id),actorName:String(actor.name||''),action,moduleKey,recordId:String(recordId||'')});
}
async function list(limit=100) {
  const take=Number.isSafeInteger(limit) ? Math.max(1,Math.min(limit,100)) : 100;
  return PlatformAuditLog.find({}).sort({createdAt:-1}).limit(take).lean();
}
async function page(before='') {
  if(typeof before!=='string'||(before&&!/^[a-f0-9]{24}$/i.test(before)))
    throw Object.assign(new Error('Invalid audit page cursor'),{status:400});
  const rows=await PlatformAuditLog.find(before?{_id:{$lt:before}}:{})
    .sort({_id:-1}).limit(101).maxTimeMS(5000).lean();
  const auditLogs=rows.slice(0,100);
  return {auditLogs,before,nextBefore:rows.length>100?String(auditLogs.at(-1)._id):null};
}
module.exports = { log,list,page };
