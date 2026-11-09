'use strict';
// Mongoose sends one createIndex round trip per declaration. These ordinary
// application models can send equivalent specifications in one server command.
// No successful marker is persisted: each caller still awaits real index setup.
function needsMongoose(Model,indexes){
 return Boolean(Model.schema.discriminatorMapping||Model.schema._baseSchema||indexes.some(([,options])=>
  ['writeConcern','w','j','wtimeout','wtimeoutMS'].some(key=>Object.hasOwn(options,key))));
}
function specifications(schema,indexes){
 return indexes.map(([key,source])=>{
  const options={...source};delete options._autoIndex;
  // Text indexes do not support collation, matching Mongoose's own behavior.
  if(Object.hasOwn(schema.options,'collation')&&!Object.hasOwn(options,'collation')&&!Object.values(key).includes('text'))options.collation=schema.options.collation;
  return {...options,key:{...key}};
 });
}
async function ensureModelIndexes(Model){
 // Retain the public model contract for adapters and older collection wrappers.
 if(typeof Model.schema?.indexes!=='function'||typeof Model.collection?.createIndexes!=='function')return Model.createIndexes();
 const indexes=Model.schema.indexes();
 // A discriminator's base-index filtering and independently chosen concerns
 // need Mongoose's per-index processing rather than a lossy approximation.
 if(needsMongoose(Model,indexes))return Model.createIndexes();
 if(!indexes.length){await Model.createCollection();return;}
 const options=Model.schema.options.writeConcern?{writeConcern:{...Model.schema.options.writeConcern}}:{};
 await Model.collection.createIndexes(specifications(Model.schema,indexes),options);
}
module.exports={ensureModelIndexes,specifications};
