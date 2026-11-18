const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const root = path.resolve(__dirname, '..');
const filename = process.argv[2];
const requests = new Map();
const server = http.createServer(async (req, res) => {
  const start = performance.now();
  if (req.url.startsWith('/slow')) await delay(120);
  requests.set(req.url, performance.now() - start);
  res.writeHead(200, {'Content-Type':'text/html', 'Cache-Control':'no-store'});
  res.end('<!doctype html><title>BrO2 benchmark</title><h1>BrO2 benchmark</h1><p>'+ 'BrO2 loopback fixture. '.repeat(300) + '</p>');
});
async function until(fn, label, timeout=25000) {
  const end = performance.now() + timeout;
  let error;
  while (performance.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (e) { error=e; }
    await delay(12);
  }
  throw new Error(label + (error ? ': ' + error.message : ''));
}
async function devtools(url) {
  const socket = new WebSocket(url);
  const waiting = new Map();
  let id = 0;
  socket.addEventListener('message', ({data}) => {
    const message = JSON.parse(data);
    if (!waiting.has(message.id)) return;
    const [resolve, reject] = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) reject(Error(message.error.message)); else resolve(message.result);
  });
  socket.addEventListener('close', () => { for (const [,reject] of waiting.values()) reject(Error('CDP closed')); waiting.clear(); });
  await new Promise((resolve,reject) => { socket.addEventListener('open',resolve,{once:true}); socket.addEventListener('error',reject,{once:true}); });
  const call = (method, params={}) => new Promise((resolve,reject) => {
    waiting.set(++id,[resolve,reject]); socket.send(JSON.stringify({id,method,params}));
  });
  return {close:()=>socket.close(), call, async eval(expression) {
    const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(r.exceptionDetails) throw Error(r.exceptionDetails.text);
    return r.result.value;
  }};
}
async function run(n, kind, dir, origin) {
  const target = origin+'/page/0';
  await fs.rm(path.join(dir,'DevToolsActivePort'),{force:true});
  await fs.writeFile(path.join(dir,'session.json'),JSON.stringify({clean:true,active:0,windows:[{active:0,tabs:Array.from({length:n},(_,i)=>({url: origin+'/page/'+i}))}]}));
  const start = performance.now();
  const app = spawn(path.join(root,'BrO2-portable','BrO2.exe'),['--user-data-dir='+dir,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1'],{stdio:'ignore'});
  const exit = new Promise(resolve=>app.once('exit',resolve));
  const sockets = [];
  try {
    const port = await until(async()=> (await fs.readFile(path.join(dir,'DevToolsActivePort'),'utf8')).split('\n')[0],'BrO2 debugging port');
    const endpoint = 'http://127.0.0.1:'+port;
    const targets = ()=>fetch(endpoint+'/json/list').then(r=>r.json());
    const shellTarget = await until(async()=>(await targets()).find(t=>t.url.endsWith('/src/index.html')),'Shell target');
    const shell = await devtools(shellTarget.webSocketDebuggerUrl);
    sockets.push(shell);
    await until(()=>shell.eval('typeof state !== "undefined" && state?.tabs?.length === '+n),'Shell ready');
    const shellMs = performance.now()-start;
    async function paint(url) {
      const t=await until(async()=>(await targets()).find(t=>t.url===url),'Page target '+url);
      const site=await devtools(t.webSocketDebuggerUrl);
      try {
        return await until(()=>site.eval('performance.getEntriesByName("first-contentful-paint")[0]?.startTime && ({fcp:performance.getEntriesByName("first-contentful-paint")[0].startTime, ttfb:performance.getEntriesByType("navigation")[0].responseStart})'),'First contentful paint '+url);
      } catch (error) {
        const shellState = await shell.eval('({ url:state.url,error:state.error,visible:state.pageVisible,visibility:document.visibilityState })');
        const siteState = await site.eval('({ url:location.href, visibility:document.visibilityState, ready:document.readyState,width:innerWidth,height:innerHeight,text:document.body?.innerText.slice(0,100),paint: performance.getEntriesByType("paint").map(e=>e.name) })');
        throw new Error(error.message + ' ' + JSON.stringify({ shellState, siteState }));
      } finally { site.close(); }
    }
    const first = await paint(target);
    const startupPaintMs = performance.now()-start;
    const pagesReady = await shell.eval('state.tabs.filter(tab=>!tab.suspended).length');
    await delay(1500);
    const memory = JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',
      '$ids=@('+app.pid+'); $all=Get-CimInstance Win32_Process -Filter "Name=\'BrO2.exe\'"; do { $before=$ids.Count; $ids+=@($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | ForEach-Object ProcessId) } while($ids.Count -gt $before); $p=Get-Process -Id $ids -ErrorAction SilentlyContinue; @{processes=@($p).Count; workingSet=($p | Measure-Object WS -Sum).Sum; privateBytes=($p | Measure-Object PM -Sum).Sum} | ConvertTo-Json -Compress'
    ],{windowsHide:true,encoding:'utf8'}));
    const switches = [];
    for (let i=0;i<7;i++) {
      const ids = await shell.eval('state.tabs.map(t=>t.id)');
      const id = ids[i%2 && n>1 ? n-1 : 0];
      const switchStart = performance.now();
      const switched = await shell.eval('new Promise((resolve,reject)=>{const id='+id+'; if(id===state.active){resolve(false);return;} const timeout=setTimeout(()=>reject(Error("Switch timeout")),4000); window.bro2.onState(next=>{if(next.active===id){clearTimeout(timeout);resolve(true);}}); window.bro2.send("select",id);})');
      if(switched) {
        const switchMs = performance.now()-switchStart;
        const index = i%2 ? n-1 : 0;
        const content = await paint(origin+'/page/'+index);
        switches.push({ selection: switchMs, ready: performance.now()-switchStart, navigationFcp: content.fcp });
      }
    }
    const navs=[];
    for (const type of ['fast','slow']) {
      const url=origin+'/'+type;
      await shell.eval('window.bro2.send("go",'+JSON.stringify(url)+')');
      const timing = await paint(url);
      navs.push({...timing, serverMs: requests.get('/'+type)});
    }
    const version=await fetch(endpoint+'/json/version').then(r=>r.json());
    const browser = await devtools(version.webSocketDebuggerUrl);
    sockets.push(browser);
    await browser.call('Browser.close').catch(()=>{});
    await Promise.race([exit,delay(8000)]);
    const out={n,kind,shellMs,startupPaintMs,first,pagesReady,memory,switches,navs};
    console.log(JSON.stringify(out));
    return out;
  } finally {
    for (const socket of sockets) socket.close();
    if (app.exitCode===null) app.kill();
  }
}
async function main() {
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin = 'http://127.0.0.1:'+server.address().port;
  const samples=[];
  for (const n of [1,10,30]) {
    const dir = await fs.mkdtemp(path.join(require('node:os').tmpdir(),'bro2-bench-'));
    await fs.writeFile(path.join(dir,'preferences.json'),JSON.stringify({settings:{startup:'restore',motion:'off'}}));
    for(const kind of ['cold','warm']) {
      samples.push(await run(n,kind,dir,origin));
      await fs.writeFile(path.join(__dirname,filename),JSON.stringify(samples,null,2));
    }
  }
}
if (require.main === module) main().catch(e=>{console.error(e);process.exitCode=1;})
  .finally(()=>{server.closeAllConnections();server.close();});
module.exports = { devtools, until };
