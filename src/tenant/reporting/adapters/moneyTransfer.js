'use strict';
// Reporting can be subscribed to alone; Money Transfer is an optional
// independently authorized source. No sender/beneficiary identifiers leave it.
module.exports=Object.freeze({
 key:'money_transfer',label:'Money Transfer requests',moduleKey:'money_transfer',
 async rows({conn,filters,scope}){
  return require('../../services/moneyTransfer.service').reportRows({conn,filters,scope});
 }
});
