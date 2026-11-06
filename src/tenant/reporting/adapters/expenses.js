'use strict';
module.exports=Object.freeze({key:'expenses',label:'Expenses',moduleKey:'expenses',
 async rows(context){return require('../../services/expenses.service').reportRows(context);}});
