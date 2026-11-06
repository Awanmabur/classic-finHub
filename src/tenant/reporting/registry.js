'use strict';
// Each future completed module adds ONE adapter conforming to {key,label,moduleKey,rows}.
// The shared Reports product never imports financial transaction controllers.
const adapters=Object.freeze([
 require('./adapters/workspace'),
 require('./adapters/expenses'),
 require('./adapters/mobileMoney'),
 require('./adapters/cashShifts'),
 require('./adapters/moneyTransfer'),
 require('./adapters/banking'),
 require('./adapters/forex'),
 require('./adapters/approvals'),
 require('./adapters/notifications')
]);
if(new Set(adapters.map(a=>a.key)).size!==adapters.length||adapters.some(a=>typeof a.rows!=='function'))
  throw new Error('Invalid reporting adapter registry');
module.exports=adapters;
