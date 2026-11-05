'use strict';
// Select only from already authorization-filtered, tenant-scoped lists.
// This helper never queries data or bypasses the existing document GET guards.
// The dashboard lists are bounded and Mobile Money covers today (UTC), so this
// is explicitly the latest visible recent acknowledgement, not all-time history.
const mongoId=/^[a-f0-9]{24}$/i;
function chooseRecentAcknowledgement({mobile=[],transfers=[]}={}){
  const choices=[];
  for(const row of mobile){
    const id=String(row?._id||'');
    const at=new Date(row?.createdAt||0).getTime();
    if(!mongoId.test(id)||!Number.isFinite(at)||at<=0)continue;
    choices.push({
      href:'/tenant/mobile-money/'+id+'/acknowledgement',
      label:'Mobile Money operational acknowledgement',
      recordedAt:new Date(at).toISOString(),at
    });
  }
  for(const row of transfers){
    const id=String(row?._id||'');
    const at=new Date(row?.createdAt||0).getTime();
    if(!mongoId.test(id)||!Number.isFinite(at)||at<=0)continue;
    choices.push({
      href:'/tenant/money-transfer/'+id+'/acknowledgement',
      label:'Money Transfer request acknowledgement',
      recordedAt:new Date(at).toISOString(),at
    });
  }
  choices.sort((a,b)=>b.at-a.at);
  if(!choices.length)return null;
  const {href,label,recordedAt}=choices[0];
  return {href,label,recordedAt};
}
module.exports={chooseRecentAcknowledgement};
