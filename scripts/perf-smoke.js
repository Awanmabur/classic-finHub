#!/usr/bin/env node
'use strict';
// Local process-only response-time probe. Not a browser Core Web Vitals or production load test.
const { performance } = require('node:perf_hooks');
const createApp = require('../src/app');
async function main() {
  const app = createApp();
  const server = await new Promise(resolve => { const s=app.listen(0,()=>resolve(s)); });
  const origin=`http://127.0.0.1:${server.address().port}`;
  const paths=['/','/pricing','/services','/faq','/images/bg.webp','/css/dashboard.css'];
  const timings=[];
  try {
    for(let round=0; round<8; round++) {
      const results=await Promise.all(paths.map(async route=>{
        const start=performance.now();
        const response=await fetch(origin+route,{signal:AbortSignal.timeout(3000)});
        const bytes=(await response.arrayBuffer()).byteLength;
        if (!response.ok || !bytes) throw new Error(`${route} failed HTTP ${response.status}`);
        return {route,ms:performance.now()-start,bytes};
      }));
      timings.push(...results);
    }
    const ms=timings.map(x=>x.ms).sort((a,b)=>a-b);
    const q=p=>ms[Math.min(ms.length-1,Math.ceil(p*ms.length)-1)].toFixed(1);
    console.log(`Local process HTTP smoke: ${timings.length} successful requests, p50=${q(.5)}ms, p95=${q(.95)}ms, max=${q(1)}ms`);
    console.log('This probe does not measure external latency, database queries, FCP, LCP, CLS, INP or production concurrency.');
  } finally { await new Promise(resolve=>server.close(resolve)); }
}
main().catch(err=>{console.error(err.message);process.exitCode=1;});
