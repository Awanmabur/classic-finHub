const { auditLogs } = require('../../data/store');
function log(actor, action, module, record) { auditLogs.unshift({ actor, action, module, record, createdAt: new Date().toISOString() }); }
module.exports = { log, list: () => auditLogs };
