'use strict';
// Bound connection acquisition and inactive sockets. Do not impose a whole-
// operation client deadline or automatically replay application mutations.
function options(input=process.env){
 const raw=input.MONGO_POOL_MAX??'30',pool=Number(raw);
 if(!/^\d+$/.test(String(raw))||!Number.isSafeInteger(pool)||pool<1||pool>200)throw Error('MONGO_POOL_MAX must be an integer from 1 to 200');
 return{serverSelectionTimeoutMS:7000,connectTimeoutMS:7000,waitQueueTimeoutMS:5000,socketTimeoutMS:30000,
  maxPoolSize:pool,autoIndex:input.NODE_ENV!=='production',bufferCommands:false,retryWrites:true};
}
module.exports={options};
