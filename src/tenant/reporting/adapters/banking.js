'use strict';
// Independent, aggregate-only source with no account holders or account numbers.
module.exports=Object.freeze({
 key:'banking',label:'Banking operation requests',moduleKey:'banking',
 async rows({conn,filters,scope}){
  return require('../../services/banking.service').reportRows({conn,filters,scope});
 }
});
