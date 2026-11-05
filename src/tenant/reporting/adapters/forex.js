'use strict';
// Optional Forex source; Reports subscribers do not need Forex. No names or
// account references leave the aggregate adapter.
module.exports=Object.freeze({
 key:'forex',label:'Indicative Forex quotations',moduleKey:'forex',
 async rows({conn,filters,scope}){return require('../../services/forex.service').reportRows({conn,filters,scope});}
});
