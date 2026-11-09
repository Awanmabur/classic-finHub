'use strict';
const MongoStore=require('connect-mongo');
async function createSessionStore({client,dbName,Store=MongoStore,log=entry=>console.error(JSON.stringify(entry))}){
 // Finish the TTL DDL before constructing connect-mongo. Its constructor starts
 // an unobserved collectionP; native autoRemove could reject before app.listen.
 await client.db(dbName).collection('sessions').createIndex({expires:1},{background:true,expireAfterSeconds:0});
 const store=Store.create({client,dbName,collectionName:'sessions',ttl:8*3600,autoRemove:'disabled',touchAfter:60});
 store.on('error',error=>log({event:'session.storage_error',code:require('./storageErrors').unavailable(error)?'STORAGE_UNAVAILABLE':'SESSION_STORE_ERROR'}));
 await store.collectionP;
 return store;
}
module.exports={createSessionStore};
