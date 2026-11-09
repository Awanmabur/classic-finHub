'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Schema}=require('mongoose');
const {ensureModelIndexes}=require('../src/config/ensureModelIndexes');
function model(schema){const calls=[];return{schema,calls,collection:{async createIndexes(specs,options){calls.push({specs,options});}},async createCollection(){calls.push({createCollection:true});},async createIndexes(){calls.push({mongooseFallback:true});}};}

test('ordinary schema indexes use one command and retain unique, partial, TTL and collation options',async()=>{
 const schema=new Schema({reference:String,expiresAt:Date,note:String},{autoIndex:false,collation:{locale:'en',strength:2},writeConcern:{w:'majority',j:true}});
 schema.index({reference:1},{unique:true,name:'unique_reference',partialFilterExpression:{reference:{$type:'string'}}});
 schema.index({expiresAt:1},{expireAfterSeconds:0,collation:{locale:'simple'}});
 schema.index({note:'text'},{weights:{note:3},default_language:'none'});
 const before=JSON.stringify(schema.indexes()),Model=model(schema);await ensureModelIndexes(Model);
 assert.equal(Model.calls.length,1);const {specs,options}=Model.calls[0];assert.equal(specs.length,3);
 assert.equal(specs[0].unique,true);assert.equal(specs[0].name,'unique_reference');assert.deepEqual(specs[0].partialFilterExpression,{reference:{$type:'string'}});assert.deepEqual(specs[0].collation,{locale:'en',strength:2});
 assert.equal(specs[1].expireAfterSeconds,0);assert.deepEqual(specs[1].collation,{locale:'simple'});
 assert.equal(specs[2].collation,undefined);assert.deepEqual(specs[2].weights,{note:3});assert.equal(specs[2].default_language,'none');
 assert.deepEqual(options,{writeConcern:{w:'majority',j:true}});assert.equal(JSON.stringify(schema.indexes()),before);
 for(const spec of specs)assert.equal(Object.hasOwn(spec,'_autoIndex'),false);
});
test('zero-index collections are explicitly prepared and rejected commands remain observable',async()=>{
 const Model=model(new Schema({name:String}));await ensureModelIndexes(Model);assert.deepEqual(Model.calls,[{createCollection:true}]);
 const indexed=model(new Schema({reference:{type:String,index:true}}));const error=Object.assign(Error('synthetic denial'),{code:13});indexed.collection.createIndexes=async()=>{throw error;};
 await assert.rejects(ensureModelIndexes(indexed),value=>value===error);
});
test('discriminator and per-index write concern semantics retain Mongoose processing',async()=>{
 const discriminator=new Schema({name:String});discriminator.discriminatorMapping={value:'Child'};discriminator.index({name:1});
 const a=model(discriminator);await ensureModelIndexes(a);assert.deepEqual(a.calls,[{mongooseFallback:true}]);
 const concern=new Schema({name:String});concern.index({name:1},{writeConcern:{w:1}});const b=model(concern);await ensureModelIndexes(b);assert.deepEqual(b.calls,[{mongooseFallback:true}]);
});
test('model adapters retain their public index method and rejected preflights',async()=>{
 let calls=0;await ensureModelIndexes({async createIndexes(){calls++;}});assert.equal(calls,1);
 const wrapped=model(new Schema({reference:{type:String,index:true}}));delete wrapped.collection.createIndexes;
 await ensureModelIndexes(wrapped);assert.deepEqual(wrapped.calls,[{mongooseFallback:true}]);
 const error=Object.assign(Error('adapter permission denied'),{code:13});
 await assert.rejects(ensureModelIndexes({async createIndexes(){throw error;}}),value=>value===error);
});
