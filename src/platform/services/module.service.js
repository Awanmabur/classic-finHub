'use strict';
const {modules}=require('../../data/store');
const unavailable=require('../../utils/unavailableOperation');
module.exports={listModules:()=>modules,toggleModule:()=>unavailable('Persistent module publishing and entitlement update')};
