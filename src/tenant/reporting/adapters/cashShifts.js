'use strict';
// Physical drawers are shared by independently subscribed financial modules.
// Reports never grants operational access to those modules or their drawers.
module.exports=Object.freeze({
 key:'cash_shifts',label:'Physical cash shifts',moduleKeys:Object.freeze(['mobile_money','money_transfer','banking','forex','expenses','loans','airtime']),
 async rows({conn,filters,scope,dateRange}){
  return require('../../services/cashDrawer.service').reportRows({conn,filters,scope,dateRange});
 }
});
