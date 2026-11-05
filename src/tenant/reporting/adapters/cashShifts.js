'use strict';
// A Mobile Money report source. The Reports module itself never requires Mobile Money.
module.exports=Object.freeze({
 key:'cash_shifts',label:'Physical cash shifts',moduleKey:'mobile_money',
 async rows({conn,filters,scope}){
  return require('../../services/cashDrawer.service').reportRows({conn,filters,scope});
 }
});
