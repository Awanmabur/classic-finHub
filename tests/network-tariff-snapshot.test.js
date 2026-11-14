'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('live Mobile Money recording takes tariff estimates only after branch authorization',()=>{
 const src=read('src/tenant/services/mobileMoney.service.js');
 const authorization=src.indexOf("financialAuthorization.service').authorizeMobileRecording");
 const estimate=src.indexOf("networkTariffService').transactionEstimates");
 const funding=src.indexOf("mobileMoneyFunds.service");
 const posting=src.indexOf("funds.apply(conn,session,authorization");
 const created=src.indexOf("[created] = await Model.create");
 assert(authorization>=0&&estimate>authorization&&funding>estimate&&posting>funding&&created>posting);
 assert(src.slice(created,created+160).includes('...tariffEstimates'));
});
test('immutable reference quote schema is separate from actual cash/float or fee posting',()=>{
 const snapshot=read('src/tenant/pricing/networkTariffSnapshot.js');
 const model=read('src/tenant/models/index.js');
 const service=read('src/tenant/pricing/networkTariffService.js');
 assert.match(snapshot,/estimated_not_received/);
 assert.match(snapshot,/scheduleId:.*immutable:true/);
 assert.match(model,/agentCommissionEstimate:.*immutable:true/);
 assert.match(model,/customerNetworkFeeEstimate:.*immutable:true/);
 assert.match(service,/effectiveFrom:\{\$lte:timestamp\}/);
 assert.match(service,/status:'approved'/);
 assert.doesNotMatch(service,/treasury\.applyMovements\(|ensureCounterAccount\(/);
});
