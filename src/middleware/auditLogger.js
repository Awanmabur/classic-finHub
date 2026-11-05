'use strict';
// Historical in-memory audit middleware is deliberately disabled. The active
// administration services write durable platform/tenant audit events in transactions.
module.exports=function auditLogger(){throw new Error('In-memory audit logging is forbidden; use a persistent audit service');};
