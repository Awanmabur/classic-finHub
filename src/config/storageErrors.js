'use strict';
// Classify storage outages without exposing exception messages, queries or URIs.
const unavailableNames=new Set(['MongoNetworkError','MongoNetworkTimeoutError','MongoServerSelectionError','MongooseServerSelectionError','MongoWaitQueueTimeoutError','MongoPoolClearedError','MongoNotConnectedError','MongoTopologyClosedError','MongoServerClosedError']);
const unavailableCodes=new Set([50,64,91,189,262,10107,11600,11602,13435,13436]);
function unavailable(error){
 if(error?.code==='STORAGE_UNAVAILABLE')return true;
 if(unavailableNames.has(error?.name))return true;
 if(error?.name==='MongoServerError'&&unavailableCodes.has(error.code))return true;
 return error?.name==='MongooseError'&&typeof error.message==='string'&&/bufferCommands\s*=\s*false|buffering timed out after/.test(error.message);
}
const publicMessage='Storage is temporarily unavailable. Check the operation history before retrying a transaction.';
module.exports={unavailable,publicMessage};
