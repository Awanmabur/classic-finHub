#!/usr/bin/env node
'use strict';
require('dotenv').config();
const {inspect}=require('../src/platform/services/productionReadiness.service');
async function main(){
 const args=process.argv.slice(2);if(args.length>1||(args.length&&!['--config-only','--live'].includes(args[0])))throw Error('Usage: npm run production:check -- [--config-only|--live]');
 const result=await inspect(process.env,{live:args[0]!=='--config-only'});
 console.log(JSON.stringify({...result,version:require('../package.json').version},null,2));
 if(!result.automatedChecksPassed)process.exitCode=2;
}
main().catch(()=>{console.error(JSON.stringify({event:'production.readiness',automatedChecksPassed:false,reason:'Readiness probe could not complete.'}));process.exitCode=2;});
