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
module.exports = { log,list };
