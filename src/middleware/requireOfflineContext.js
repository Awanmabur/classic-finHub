'use strict';
// Bind a queued browser instruction to its original account version and physical
// branch. The POST's live authentication and mutation fences remain authoritative.
module.exports=function requireOfflineContext(req,res,next){
 const scope=req.get('X-ClassicFin-Offline-Scope');
 if(req.method!=='POST'||scope===undefined)return next();
 const branch=req.get('X-ClassicFin-Offline-Branch'),current=require('../tenant/services/offlineIdentity')(req);
 if(!/^[a-f0-9]{64}$/.test(scope)||!/^[a-f0-9]{24}$/i.test(branch||'')||scope!==current.scope||branch.toLowerCase()!==current.branchId.toLowerCase()){
  return next(Object.assign(Error('Your account or operating branch changed. Refresh the workspace and review this saved entry before trying again.'),{status:409}));
 }
 next();
};
