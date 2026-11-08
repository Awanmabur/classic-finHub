'use strict';
// Configuration parsing only: MongoClient construction does not connect or
// resolve SRV records. Never include a URI or driver error in configuration errors.
const {MongoClient}=require('mongoose').mongo;
const {tenantDbNameFromSlug}=require('./tenantDatabaseName');
const DEFAULT_PLATFORM_URI='mongodb://127.0.0.1:27017/classicfin_platform_db';
const IGNORE_OPTIONS=new Set(['dbName','appName','metadata','extendedMetadata','mongoLoggerOptions','pkFactory','userSpecifiedAuthSource','userSpecifiedReplicaSet']);
function fail(message){return new Error(message);}
function value(input,key){
 const supplied=input[key];
 if(supplied===undefined||supplied===null||supplied==='')return null;
 if(typeof supplied!=='string')throw fail(key+' must be a MongoDB connection URI');
 return supplied.trim()||null;
}
function parseMongoUri(uri,label='MongoDB URI',{requireDatabase=true,emptyDatabase=false}={}){
 const shape=typeof uri==='string'&&/^(mongodb(?:\+srv)?):\/\/([^/?#]+)(?:\/([^?#]*))?(?:\?([^#]*))?$/i.exec(uri);
 if(!shape)throw fail(label+' must be a MongoDB connection URI');
 if(requireDatabase&&!shape[3])throw fail(label+' must explicitly name the platform database');
 if(emptyDatabase&&shape[3])throw fail(label+' must leave the database path empty');
 let client;
 try{client=new MongoClient(uri);}catch{throw fail(label+' contains invalid MongoDB connection settings');}
 if(requireDatabase&&(!client.options.dbName||Buffer.byteLength(client.options.dbName)>63||/[\x00\s/\\."$]/.test(client.options.dbName)))throw fail(label+' must explicitly name a valid platform database');
 const query=new URLSearchParams(shape[4]||'');
 return {uri,scheme:shape[1].toLowerCase(),authority:shape[2],database:shape[3]||'',query,options:client.options,explicitAuthSource:[...query.keys()].some(key=>key.toLowerCase()==='authsource')};
}
function stable(value){
 if(value===undefined)return undefined;
 // The driver implements tlsAllowInvalidHostnames with a function. Retain its
 // presence so a weaker derived URI cannot compare equal to validated TLS.
 if(typeof value==='function')return '[function]';
 if(value===null||typeof value!=='object')return value;
 if(Buffer.isBuffer(value))return value.toString('base64');
 if(Array.isArray(value))return value.map(stable);
 if(value instanceof Map)return stable(Object.fromEntries(value));
 return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]).filter(([,entry])=>entry!==undefined));
}
function identity(parsed,{inferSrvAuthSource=false}={}){
 const options={};
 for(const [key,entry] of Object.entries(parsed.options)){
  if(IGNORE_OPTIONS.has(key))continue;
  options[key]=key==='hosts'?entry.map(host=>host.toString().toLowerCase()).sort():key==='srvHost'?String(entry).toLowerCase():
   key==='credentials'&&entry&&inferSrvAuthSource?{...entry,source:'[resolved by platform SRV]'}:entry;
 }
 return JSON.stringify(stable({scheme:parsed.scheme,options}));
}
function resolveMongoConfiguration(input=process.env){
 const primary=value(input,'MONGO_PLATFORM_URI'),alias=value(input,'PLATFORM_DB_URI');
 if(!primary&&!alias&&input.NODE_ENV==='production')throw fail('Production requires MONGO_PLATFORM_URI or PLATFORM_DB_URI with a database name');
 const selected=primary||alias||DEFAULT_PLATFORM_URI;
 const platform=parseMongoUri(selected,primary?'MONGO_PLATFORM_URI':alias?'PLATFORM_DB_URI':'MONGO_PLATFORM_URI');
 if(primary&&alias){
  const alternative=parseMongoUri(alias,'PLATFORM_DB_URI');
  if(platform.options.dbName!==alternative.options.dbName||identity(platform)!==identity(alternative))throw fail('MONGO_PLATFORM_URI and PLATFORM_DB_URI conflict; configure one platform connection');
 }
 const base=value(input,'MONGO_URI_BASE');
 if(base){
  const parsedBase=parseMongoUri(base,'MONGO_URI_BASE',{requireDatabase:false,emptyDatabase:true});
  // SRV DNS TXT may supply authSource only when the client connects. Comparing
  // constructor defaults here would compare the platform DB with "admin".
  // Both omitted SRV sources inherit the connected platform client's resolution;
  // mixed explicit/implicit settings and ordinary authenticated pairs stay strict.
  const inferSrvAuthSource=platform.scheme==='mongodb+srv'&&parsedBase.scheme==='mongodb+srv'&&!platform.explicitAuthSource&&!parsedBase.explicitAuthSource;
  if((platform.options.credentials||parsedBase.options.credentials)&&(!platform.explicitAuthSource||!parsedBase.explicitAuthSource)&&!inferSrvAuthSource)throw fail('Set the same authSource in both platform/base URIs, or omit it from both when using SRV');
  if(identity(platform,{inferSrvAuthSource})!==identity(parsedBase,{inferSrvAuthSource}))throw fail('MONGO_URI_BASE must match platform deployment, credentials, authSource, TLS and connection options; only appName may differ');
 }
 return {mongoPlatformUri:selected,mongoUriBase:base};
}
function platformUri(input=process.env){return resolveMongoConfiguration(input).mongoPlatformUri;}
function tenantUriFromSlug(slug,input=process.env,{resolvedAuthSource}={}){
 const database=tenantDbNameFromSlug(slug),config=resolveMongoConfiguration(input);
 if(database.toLowerCase()===parseMongoUri(config.mongoPlatformUri,'Platform MongoDB URI').options.dbName.toLowerCase())throw fail('Tenant and platform database names must be distinct');
 const selected=parseMongoUri(config.mongoUriBase||config.mongoPlatformUri,config.mongoUriBase?'MONGO_URI_BASE':'MONGO_PLATFORM_URI',{requireDatabase:!config.mongoUriBase,emptyDatabase:!!config.mongoUriBase});
 if(selected.options.credentials&&!selected.explicitAuthSource){
  // A new DB path must not become a new authentication DB. For SRV, use the
  // real client result (TXT or original platform-DB fallback), never guess admin.
  const source=selected.scheme==='mongodb+srv'?resolvedAuthSource:parseMongoUri(config.mongoPlatformUri,'Platform MongoDB URI').options.credentials?.source;
  if(typeof source!=='string'||!source)throw fail('Connect to platform MongoDB before deriving tenant links with an implicit SRV authSource, or set authSource explicitly');
  selected.query.set('authSource',source);
 }
 const query=selected.query.toString();
 return `${selected.scheme}://${selected.authority}/${database}${query?'?'+query:''}`;
}
module.exports={resolveMongoConfiguration,platformUri,tenantUriFromSlug,parseMongoUri};
