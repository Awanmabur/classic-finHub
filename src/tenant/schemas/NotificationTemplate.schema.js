'use strict';
const mongoose=require('mongoose');
const O=mongoose.Schema.Types.ObjectId;
const schema=new mongoose.Schema({
 code:{type:String,required:true,immutable:true,match:/^[a-z][a-z0-9_]{2,39}$/},
 version:{type:Number,required:true,immutable:true,min:1},
 name:{type:String,required:true,immutable:true,maxlength:100},
 subject:{type:String,required:true,immutable:true,maxlength:120},
 body:{type:String,required:true,immutable:true,maxlength:1000},
 emailAvailable:{type:Boolean,required:true,immutable:true},
 status:{type:String,enum:['active','retired'],default:'active'},
 createdBy:{type:O,required:true,immutable:true},createdAt:{type:Date,default:Date.now,immutable:true},
 retiredAt:{type:Date,default:null},retiredBy:{type:O,default:null}
},{strict:'throw',versionKey:false});
schema.index({code:1,version:1},{unique:true});
schema.index({code:1,status:1},{unique:true,partialFilterExpression:{status:'active'}});
module.exports=schema;
