// Fixed children retain ordinary block and inline flow around the data window.
import { beforeAll, beforeEach, afterAll, test as bunTest, expect } from 'bun:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hostFixtureFile } from './tests/glue-fixture.mjs';
import { withLook } from './look.mjs';
const sheet = withLook(readFileSync(new URL('./index.html', import.meta.url), 'utf8')).split('<style>')[1].split('</style>')[0];
import { cdpBrowser, chromium } from '../../scripts/agent-launch.mjs';
import { need } from '../../scripts/coverage.mjs';
const { unavailable } = chromium();
const test = need('chrome', unavailable, { test: bunTest });
let server, suite, evaluate, call, fixtureDir;
beforeAll(async () => {
  if (unavailable) return;
  fixtureDir = mkdtempSync(join(tmpdir(), 'exact-fixed-'));
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) {
    const url = new URL(req.url), path = url.pathname;
    if (path === '/host/web-js/names.js') return new Response('export const sourceTypes = {};', {headers:{'content-type':'text/javascript'}});
    if (path.endsWith('/names.js')) return new Response(readFileSync(join(fixtureDir,'virtual','names.js')), {headers:{'content-type':'text/javascript'}});
    if (path.startsWith('/host/')) {
      const file = resolve('.' + path);
      if (!existsSync(file) && path.startsWith('/host/web-js/')) return Response.redirect(new URL(path.replace('/host/web-js/', '/host/web/'), url));
      return new Response(hostFixtureFile(file), {headers:{'content-type':'text/javascript'}});
    }
    if (path.startsWith('/app/')) {
      const parts = path.slice(5).split('/'), mode = parts.shift(), name = parts.join('/');
      if (!name) return new Response('<!doctype html><style>'+sheet+'</style><link rel="stylesheet" href="app.css"><div id="exact-root"></div><script type="module">import("./app.js").then(({default:app})=>{app();globalThis.ready=true;}).catch(e=>{globalThis.appError=e.stack;});</script>', {headers:{'content-type':'text/html'}});
      const compiled = join(fixtureDir, mode, name);
      if (!existsSync(compiled)) return Response.redirect(new URL('/host/web-js/' + name, url));
      return new Response(hostFixtureFile(compiled), {headers:{'content-type':name.endsWith('.css')?'text/css':'text/javascript'}});
    }
    return new Response(path === '/collection-glue.js'
      ? readFileSync(new URL('./collection-glue.js', import.meta.url)) : '<!doctype html><body><main></main>',
    { headers: { 'content-type': path.endsWith('.js') ? 'text/javascript' : 'text/html' } });
  }});
  suite = await cdpBrowser();
  const { sessionId } = await suite.page();
  call = (method, params) => suite.cdp.send(method, params, sessionId);
  evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
}, 60_000);
beforeEach(async () => {
  if (unavailable) return;
  await call('Page.navigate', {url:`http://127.0.0.1:${server.port}/`});
  await evaluate(`import('/collection-glue.js').then(c => { globalThis.createController = c.collectionController; })`);
});
afterAll(async () => { await suite?.close(); server?.stop(true); if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true }); }, 60_000);

test('end-follow keeps the measured footer throughout a final row exit', async () => {
  const result = await evaluate(`(async () => {
    const rt=await import('/host/web-js/rt.js'),{vl}=await import('/host/web-js/list.js');
    await import('/host/web-js/list-items.js');
    document.querySelector('main').id='exact-root';
    document.head.insertAdjacentHTML('beforeend','<style>@keyframes leave { to { opacity:0 } }</style>');
    const count=rt.sig(3);let list;
    rt.mount(root=>{
      list=rt.h(root,'div',0,{'data-exact-list':''},0);
      list.style.cssText='height:200px;width:320px;overflow:auto;position:relative';
      vl(list,()=>Array.from({length:count()},(_,n)=>n),i=>i(),parent=>{
        const row=rt.h(parent,'div',0,{},'Row');
        row.style.cssText='height:40px;--exact-exit-animation:leave 1000ms linear both';rt.pr(row);
      },{est:40,pw:[320],ph:[200],follow:()=>true,fixed:[()=>{},parent=>{
        const footer=rt.h(parent,'div',0,{},0);footer.style.height='300px';
      }]});
    });
    await rt.pieces();await exact.lists.pending();await exact.lists.settle();
    list.scrollTop=100000;await exact.lists.settle();
    rt.act(()=>rt.W(count,2))();await exact.lists.pending();
    const ghost=list.querySelector('[data-exiting]');
    if(!ghost)throw Error('the removed row must keep a real exit box');
    const animation=ghost.getAnimations()[0];animation.pause();
    const samples=[];
    const sample=()=>({footer:list.$list.index.fixed[1],extent:list.$list.index.total,offset:list.scrollTop,end:list.scrollHeight-list.clientHeight});
    for(const time of [0,250,750,1000]) {
      animation.currentTime=time;
      exact.lists.internals.controller().restyled();await exact.lists.settle();samples.push(sample());
    }
    animation.finish();await animation.finished;await Promise.resolve();
    await exact.lists.settle();samples.push(sample());
    return samples;
  })()`);
  for (const sample of result) {
    expect(sample.footer).toBe(300);
    expect(sample.extent).toBe(380);
    expect(sample.offset).toBe(sample.end);
    expect(sample.end).toBe(180);
  }
}, 30_000);

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


test('the compiled list has eager boxes, stable fixed children, and follows a growing trail', async () => {
  const source = readFileSync(new URL('../../contract/corpus/list-fixed.contract', import.meta.url), 'utf8');
  for (const mode of ['virtual', 'eager']) {
    const path = join(fixtureDir, mode + '.contract');
    writeFileSync(path, mode === 'virtual' ? source : source.replace('virtualized=true', 'virtualized=false').replace(' estimated-item-height=40', ''));
    const built = Bun.spawnSync([resolve('target/debug/exact-web-js'), 'js', path, '-o', join(fixtureDir, mode)]);
    if (built.exitCode) throw Error(new TextDecoder().decode(built.stderr));
  }
  const boxes = [];
  for (const mode of ['eager', 'virtual']) {
    await call('Page.navigate', {url:`http://127.0.0.1:${server.port}/app/${mode}/`});
    await evaluate(`new Promise((resolve,reject)=>{const read=async()=>{if(globalThis.ready){await globalThis.exact?.lists?.pending();await globalThis.exact?.lists?.settle();resolve();}else requestAnimationFrame(read);};read();setTimeout(()=>reject(Error('app did not mount: '+globalThis.appError+' '+document.body.innerHTML)),5000);})`);
    const read = () => evaluate(`(() => { const list=document.querySelector('[data-testid="list"]');return [...list.querySelectorAll('[data-testid]')].map(el=>{const r=el.getBoundingClientRect(),p=list.getBoundingClientRect();return [el.dataset.testid,r.x-p.x,r.y-p.y+list.scrollTop,r.width,r.height];});})()`);
    const stages = [await read()];
    boxes.push(stages);
    await evaluate(`document.querySelector('[data-testid="list"]').scrollTop=100000;globalThis.exact?.lists?.settle()`);
    stages.push(await read());
    await evaluate(`document.querySelector('[data-testid="grow"]').click();globalThis.exact?.lists?.settle()`);
    stages.push(await read());
    const end = await evaluate(`(() => {const el=document.querySelector('[data-testid="list"]');return [el.scrollTop,el.scrollHeight-el.clientHeight];})()`);
    if (mode === 'virtual') {
      expect(end[0]).toBe(end[1]);
      const transformed = await evaluate(`(async () => {
        const list=document.querySelector('[data-testid="list"]'),footer=document.querySelector('[data-testid="tail"]');
        const before=[list.scrollTop,list.scrollHeight-list.clientHeight,list.$list.index.fixed[1]];
        footer.style.transform='scale(0.5)';exact.lists.internals.controller().restyled();await exact.lists.settle();
        return {before,after:[list.scrollTop,list.scrollHeight-list.clientHeight,list.$list.index.fixed[1]]};
      })()`);
      expect(transformed.after).toEqual(transformed.before);

    }
  }
  for (let stage = 0; stage < 3; stage++) {
    const mounted = new Set(boxes[1][stage].map(box => box[0]));
    expect(boxes[1][stage]).toEqual(boxes[0][stage].filter(box => mounted.has(box[0])));
  }
}, 30_000);

test('intrinsic image growth beneath contents shells is measured without a commit', async () => {
  const result = await evaluate(`(async () => {
    document.body.innerHTML='<main><div style="height:100px;width:320px;overflow:auto"><div style="display:contents"><img style="display:block"></div><div style="height:40px"></div><div style="display:contents"><img style="display:block"></div></div></main>';
    const root=document.querySelector('main'),port=root.firstElementChild,[lead,row,trail]=port.children;
    const views=new Map([[1,port],[2,row],[3,lead],[4,trail]]),seen=[];
    let changed;
    const growth=new Promise(resolve=>changed=resolve);
    const controller=createController({root,views,report(bytes){
      const d=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),n=d.getUint32(96,true);
      const sizes=Array.from({length:n},(_,i)=>d.getFloat64(112+i*20,true));seen.push(sizes);
      if(sizes.at(-2)===240 && sizes.at(-1)===360)changed(sizes);
    }});
    controller.commit([{view:1,revision:'1',scrollSequence:'0',count:1,totalExtent:40,rows:[{view:2,root:2,index:0,start:0,size:40,epoch:'1'}],fixed:[{view:5,roots:[3],size:0,epoch:'1'},{view:6,roots:[4],size:0,epoch:'1'}]}]);
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    for(const [shell,height] of [[lead,240],[trail,360]])shell.firstElementChild.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="'+height+'"/>');
    try { return await Promise.race([growth,new Promise(resolve=>setTimeout(()=>resolve(seen.at(-1)),2000))]); }
    finally { controller.dispose(); }
  })()`);
  expect(result.slice(-2)).toEqual([240, 360]);
});

