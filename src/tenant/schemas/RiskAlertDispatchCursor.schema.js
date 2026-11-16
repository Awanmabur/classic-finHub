'use strict';
const mongoose=require('mongoose');
// Worker-owned retry position: never grants notification services financial writes.
const schema=new mongoose.Schema({
 _id:{type:String,required:true,enum:['mobile_money_risk']},
 lastCreatedAt:{type:Date,required:true},
 lastId:{type:mongoose.Schema.Types.ObjectId,required:true},
 updatedAt:{type:Date,default:Date.now}
},{strict:'throw',versionKey:false});
module.exports=schema;
