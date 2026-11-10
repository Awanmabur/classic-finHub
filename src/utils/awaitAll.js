'use strict';
// Start independent work together, observe every rejection, and keep the
// original operation order when choosing the error returned to the caller.
module.exports=async function awaitAll(promises){
 const results=await Promise.allSettled(promises);
 for(const result of results)if(result.status==='rejected')throw result.reason;
 return results.map(result=>result.value);
};
