'use strict';
// Mobile Money reports only aggregate figures. Recording, review and settlement
// remain protected by their own module and role permissions.
module.exports=Object.freeze({
 key:'mobile_money',label:'Mobile Money',moduleKey:'mobile_money',
 async rows({conn,filters,scope}){
  const summary=await require('../../services/mobileMoney.service').getSummary(conn,{from:filters.from,to:filters.to,...scope});
  return summary.summaries.map(s=>({module:'Mobile Money',activity:`${s._id.network} · ${s._id.operation}`,
   status:`${s._id.status} / ${s._id.reviewState} / ${s._id.correctionState||'none'}`,currency:s._id.currency,count:s.count,volume:s.volumeFormatted,fees:s.feesFormatted}));
 }
});
