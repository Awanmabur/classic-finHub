'use strict';
const mongoose = require('mongoose');
const {currencyCodes}=require('../../config/currencies');
const schema = new mongoose.Schema({
  code: { type: String, required:true, trim:true, lowercase:true, immutable:true, match:/^[a-z0-9][a-z0-9-]{1,30}$/ },
  name: { type:String, required:true, trim:true, maxlength:100 },
  address: { type:String, default:'', trim:true, maxlength:240 },
  currency: { type:String, enum:currencyCodes, required:true, immutable:true },
  status: { type:String, enum:['active','archived'], default:'active', required:true },
  revision: { type:Number, default:0, min:0 },
  createdBy: { type:mongoose.Schema.Types.ObjectId, required:true, immutable:true },
  updatedBy: { type:mongoose.Schema.Types.ObjectId, required:true }
}, {timestamps:true,strict:'throw'});
schema.index({code:1},{unique:true});
schema.index({status:1,createdAt:-1});
module.exports = schema;
