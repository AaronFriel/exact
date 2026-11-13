// Fixed children retain ordinary block and inline flow around the data window.
import { beforeAll, afterAll, test as bunTest, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { cdpBrowser, chromium } from '../../scripts/agent-launch.mjs';
import { need } from '../../scripts/coverage.mjs';
const { unavailable } = chromium();
const test = need('chrome', unavailable, { test: bunTest });
let server, suite, evaluate;
beforeAll(async () => {
  if (unavailable) return;
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) {
    return new Response(new URL(req.url).pathname === '/collection-glue.js'
      ? readFileSync(new URL('./collection-glue.js', import.meta.url)) : '<!doctype html><body><main></main>',
    { headers: { 'content-type': req.url.endsWith('.js') ? 'text/javascript' : 'text/html' } });
  }});
  suite = await cdpBrowser();
  const { sessionId } = await suite.page();
  const call = (method, params) => suite.cdp.send(method, params, sessionId);
  evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  await call('Page.navigate', { url: `http://127.0.0.1:${server.port}` });
  await evaluate(`import('/collection-glue.js').then(c => { globalThis.createController = c.collectionController; })`);
}, 60_000);
afterAll(async () => { await suite?.close(); server?.stop(true); }, 60_000);

test('fixed measurements include a growing trail and keep authored padding', async () => {
  const result = await evaluate(`(() => {
    const root=document.querySelector('main');root.innerHTML='<div style="height:180px;width:320px;overflow:auto;padding:10px"><div style="height:80px"></div><div style="height:40px"></div><div style="height:1800px"></div><div style="height:900px"></div></div>';
    const port=root.firstElementChild,[lead,row,space,trail]=port.children,views=new Map([[1,port],[2,row],[3,lead],[4,trail]]),seen=[],frames=[];
    const controller=createController({root,views,report(bytes){const d=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);seen.push({padding:[d.getFloat64(56,true),d.getFloat64(64,true)],sizes:Array.from({length:d.getUint32(96,true)},(_,i)=>d.getFloat64(112+i*20,true))});},requestFrame(f){frames.push(f);return frames.length;},cancelFrame(){}});
    const flush=()=>{for(const f of frames.splice(0))f();};
    controller.commit([{view:1,revision:'1',scrollSequence:'0',count:100,totalExtent:2740,rows:[{view:2,root:2,index:0,start:80,size:40,epoch:'1'}],fixed:[{view:5,roots:[3],size:80,epoch:'1'},{view:6,roots:[4],size:900,epoch:'1'}]}]);flush();
    const before=seen.at(-1);trail.style.height='1100px';controller.restyled();flush();const after=seen.at(-1);trail.style.transform='scale(0.5)';controller.restyled();flush();const transformed=seen.at(-1);controller.dispose();return {before,after,transformed};
  })()`);
  expect(result.before.sizes.slice(-2)).toEqual([80, 900]);
  expect(result.after.sizes.slice(-2)).toEqual([80, 1100]);
  expect(result.after.padding).toEqual([10, 10]);
  expect(result.transformed.sizes.slice(-2)).toEqual([80, 1100]);
});
