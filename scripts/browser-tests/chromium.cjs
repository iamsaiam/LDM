const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { parseArgs } = require('node:util');
const { values: options } = parseArgs({ options: {
  fixture: { type: 'string' }, artifacts: { type: 'string' },
  chrome: { type: 'string' }, 'allow-no-sandbox': { type: 'boolean', default: false }
} });
if (!options.fixture || !options.artifacts) throw new Error('--fixture and --artifacts are required');
const extension = path.resolve(__dirname, '../../extension');
const artifacts = path.resolve(options.artifacts);
const systemChrome = Boolean(options.chrome);
const tag = systemChrome ? 'ldm-chrome' : 'ldm-chromium';
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function wait(fn, description, timeout=20000) {
  const end=Date.now()+timeout; let last;
  while(Date.now()<end) { try { const value=await fn(); if(value)return value; } catch(e) { last=e; } await sleep(100); }
  throw new Error(`${description} timed out${last?`: ${last.message}`:''}`);
}
(async()=>{
  const fixture=JSON.parse(await fs.readFile(options.fixture,'utf8'));
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'ldm-chromium-profile-'));
  const report={browser:systemChrome?'Google Chrome':'Chromium', profile, checks:[], errors:[], outputs:[]};
  let context;
  await fs.mkdir(artifacts,{recursive:true});
  const jobs=async()=> (await(await fetch(fixture.engine+'/api/downloads')).json()).downloads;
  const baseline=new Set((await jobs()).map(j=>j.id));
  const freshJobs=async()=> (await jobs()).filter(j=>!baseline.has(j.id));
  const job=async id=>(await jobs()).find(j=>j.id===id);
  try {
    context=await chromium.launchPersistentContext(profile, {
      ...(systemChrome?{executablePath:options.chrome}:{channel:'chromium'}), headless:true, chromiumSandbox:!options['allow-no-sandbox'],
      env:{...process.env,XDG_CONFIG_HOME:path.join(profile,'xdg-config'),XDG_CACHE_HOME:path.join(profile,'xdg-cache')},
      ignoreDefaultArgs:['--disable-extensions'],
      viewport:{width:1280,height:850},
      args:systemChrome?['--enable-unsafe-extension-debugging']:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]
    });
    report.version=context.browser().version();
    report.testIsolation = options['allow-no-sandbox'] ? 'Fresh temporary profile; explicitly authorized sandbox exception for generated localhost fixtures only' : 'Fresh temporary profile with browser sandbox enabled';
    if(systemChrome){
      const loading=await context.browser().newBrowserCDPSession();
      report.installed=await loading.send('Extensions.loadUnpacked',{path:extension});
    }
    context.on('page',p=>{
      p.on('pageerror',e=>report.errors.push(e.message));
      p.on('console',m=>{if(m.type()==='error')report.errors.push({message:m.text(),url:m.location().url});});
    });
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const id=worker.url().split('/')[2]; report.extensionId=id;
    const media=await context.newPage();
    await media.goto(fixture.source+'/watch');
    await media.locator('.ldm-trigger').waitFor();
    await wait(()=>media.locator('#fixture-video').evaluate(v=>v.readyState>=2),'native video metadata');
    await media.locator('.ldm-trigger').click();
    const row=media.locator('.ldm-stream').filter({hasText:'protected.mp4'});
    await row.waitFor();
    await media.screenshot({path:path.join(artifacts,`${tag}-detection.png`)});
    report.directDiscovery=await worker.evaluate(async()=>{const stored=await chrome.storage.session.get('detectedStreamsByTab');return Object.values(stored.detectedStreamsByTab||{}).flat().map(s=>({filename:s.filename,source:s.detectionSource,headerNames:Object.keys(s.headers||{})}));});
    await row.locator('.ldm-download').click();
    const direct=await wait(async()=> (await freshJobs()).find(j=>j.status==='completed'&&j.filename.startsWith('protected')), 'authenticated direct completion');
    const bytes=await fs.readFile(path.join(fixture.download_dir,direct.filename));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),fixture.video_sha256);
    report.checks.push('native player/network discovery; captured Cookie/Referer; real direct download and SHA-256');
    report.outputs.push(direct.filename);
    await media.bringToFront();
    let popupPromise=context.waitForEvent('page');
    await worker.evaluate(url=>chrome.tabs.create({url,active:false}),`chrome-extension://${id}/popup.html`);
    let popup=await popupPromise; await popup.waitForLoadState();
    await wait(async()=> (await popup.locator('#transfers').innerText()).includes(direct.filename),'popup completed history');
    await popup.close();
    report.checks.push('actual popup loads completed transfer history');

    await media.goto(fixture.source+'/watch-slow');
    await media.locator('.ldm-trigger').waitFor(); await media.locator('.ldm-trigger').click();
    const slowRow=media.locator('.ldm-stream').filter({hasText:'slow.mp4'});
    await slowRow.waitFor(); await slowRow.locator('.ldm-download').click();
    const slow=await wait(async()=> (await freshJobs()).find(j=>j.status==='downloading'&&j.filename.startsWith('slow')&&j.bytes_downloaded>0),'slow live transfer');
    await slowRow.locator('.ldm-pause').click();
    await wait(async()=> (await job(slow.id)).status==='paused','extension pause');
    await media.screenshot({path:path.join(artifacts,`${tag}-paused.png`)});
    await slowRow.locator('.ldm-pause').click();
    await wait(async()=>{const current=await job(slow.id);return current.status==='downloading'&&current.bytes_downloaded>slow.bytes_downloaded;},'extension resume');
    await slowRow.locator('.ldm-download').click();
    await wait(async()=> (await job(slow.id)).status==='cancelled','extension cancel');
    try { await fs.stat(path.join(fixture.download_dir,slow.filename)); throw new Error('Cancelled final file exists'); }
    catch(e) { if(e.code!=='ENOENT')throw e; }
    report.checks.push('real overlay Pause/Resume/Cancel and cancelled output cleanup');

    await media.goto(fixture.source+'/watch-hls');
    await media.locator('.ldm-trigger').waitFor(); await media.locator('.ldm-trigger').click();
    const manifest=media.locator('.ldm-stream').filter({hasText:'master.m3u8'});
    await manifest.waitFor(); await manifest.locator('.ldm-download').click();
    const picker=manifest.locator('.media-options'); await picker.waitFor();
    const qualities=await picker.getByRole('combobox',{name:'Video quality',exact:true}).locator('option').allTextContents();
    assert(qualities.some(q=>q.includes('180p'))&&qualities.some(q=>q.includes('360p')));
    const label=qualities.find(q=>q.includes('360p'));
    await picker.getByRole('combobox',{name:'Video quality',exact:true}).selectOption({label});
    await picker.getByRole('combobox',{name:'File format',exact:true}).selectOption('mkv');
    assert.equal(await manifest.locator('.ldm-quality').innerText(),'360p');
    await picker.scrollIntoViewIfNeeded();
    await media.screenshot({path:path.join(artifacts,`${tag}-quality.png`)});
    await manifest.locator('.ldm-download').click();
    const selected=await wait(async()=> (await freshJobs()).find(j=>j.status==='completed'&&j.filename.endsWith('.mkv')),'selected HLS completion');
    const inspection=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',path.join(fixture.download_dir,selected.filename)],{encoding:'utf8'}));
    assert.equal(inspection.streams.find(s=>s.codec_type==='video').height,360);
    assert(inspection.streams.some(s=>s.codec_type==='audio'));
    report.checks.push('actual HLS inspection, 180p/360p picker and selected 360p MKV+audio output');
    report.outputs.push(selected.filename);

    await media.bringToFront();
    popupPromise=context.waitForEvent('page');
    await worker.evaluate(url=>chrome.tabs.create({url,active:false}),`chrome-extension://${id}/popup.html`);
    popup=await popupPromise; await popup.waitForLoadState();
    const audioRow=popup.locator('.stream-card').filter({hasText:'master.m3u8'});
    await audioRow.locator('.download-button').click();
    const audioPicker=audioRow.locator('.media-options'); await audioPicker.waitFor();
    await audioPicker.getByRole('combobox',{name:'Save',exact:true}).selectOption('audio');
    await audioPicker.getByRole('combobox',{name:'File format',exact:true}).selectOption('mp3');
    assert.equal(await audioRow.locator('.badge').innerText(),'Audio only');
    assert.equal(await audioRow.locator('.format-badge').innerText(),'MP3');
    await audioRow.locator('.download-button').click();
    const audioOnly=await wait(async()=> (await freshJobs()).find(j=>j.status==='completed'&&j.filename.endsWith('.mp3')),'popup audio-only completion');
    const audioInfo=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',path.join(fixture.download_dir,audioOnly.filename)],{encoding:'utf8'}));
    assert(audioInfo.streams.length===1&&audioInfo.streams[0].codec_type==='audio'&&audioInfo.streams[0].codec_name==='mp3');
    await wait(()=>popup.locator('.stream-card').filter({hasText:audioOnly.filename})
      .locator('.download-button').innerText().then(text=>text.includes('Completed')),'popup completion notification path');
    await sleep(300);
    assert(!report.errors.some(e=>JSON.stringify(e).includes('Could not show LDM notification')),'notification API rejected the completion notification');
    report.outputs.push(audioOnly.filename);
    report.checks.push('actual popup Audio only/MP3 conversion, accurate selection badges and completion notification API');
    await popup.close();

    const cdp=await context.newCDPSession(media);
    const targets=await cdp.send('Target.getTargets');
    const target=targets.targetInfos.find(t=>t.type==='service_worker'&&t.url.includes(id));
    assert(target,'installed extension worker missing');
    await cdp.send('Target.closeTarget',{targetId:target.targetId});
    popup=await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await wait(async()=>{const text=await popup.locator('#transfers').innerText();return text.includes(direct.filename)&&text.includes(selected.filename)&&text.includes('CANCELLED');},'worker restart/history recovery');
    await popup.screenshot({path:path.join(artifacts,`${tag}-popup-recovery.png`),fullPage:true});
    report.checks.push('actual MV3 worker termination/restart and popup history recovery');
    report.status='passed';
  } catch(error) {
    report.status='failed'; report.failure=error.stack;
    if(context)for(const [index,p] of context.pages().entries()) {
      try {await p.screenshot({path:path.join(artifacts,`${tag}-failure-${index}.png`),fullPage:true});}catch{}
    }
    process.exitCode=1;
  } finally {
    if(context)await context.close();
    await fs.writeFile(path.join(artifacts,`${tag}-live-report.json`),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
  }
})();
