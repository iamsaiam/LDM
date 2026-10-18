import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

parser=argparse.ArgumentParser(description='Exercise a temporary LDM add-on in a real Firefox browser.')
parser.add_argument('--fixture',type=Path,required=True)
parser.add_argument('--artifacts',type=Path,required=True)
parser.add_argument('--firefox',type=Path,required=True)
parser.add_argument('--geckodriver',type=Path,required=True)
parser.add_argument('--allow-browser-ui',action='store_true',help='Enable local WebDriver access to extension pages and browser UI')
args=parser.parse_args()
if not args.allow_browser_ui:parser.error('Popup checks require explicit --allow-browser-ui for a temporary profile')
fixture=json.loads(args.fixture.read_text())
root=Path(tempfile.mkdtemp(prefix='ldm-firefox-check-'))
artifacts=args.artifacts.resolve();artifacts.mkdir(parents=True,exist_ok=True)
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
report={'browser':'Firefox','checks':[],'outputs':[],'testIsolation':'Fresh temporary profile; loopback-only WebDriver with browser UI access for extension pages; content sandbox unchanged'}
def wait(function,description,seconds=25):
    end=time.monotonic()+seconds;last=None
    while time.monotonic()<end:
        try:
            value=function()
            if value:return value
        except Exception as error:last=error
        time.sleep(.1)
    raise AssertionError(f'{description} timed out: {last}')
def json_request(url,data=None,method=None):
    request=urllib.request.Request(url,data=json.dumps(data).encode() if data is not None else None,
                                  method=method,headers={'Content-Type':'application/json'})
    try:response=opener.open(request,timeout=45)
    except urllib.error.HTTPError as error:response=error
    with response:
        value=json.load(response)
        if response.status>=400:raise RuntimeError(json.dumps(value))
        return value
def jobs():return json_request(fixture['engine']+'/api/downloads')['downloads']
baseline={job['id'] for job in jobs()}
def new_job(predicate):return next((job for job in jobs() if job['id'] not in baseline and predicate(job)),None)
def job(identifier):return next((job for job in jobs() if job['id']==identifier),None)
with socket.socket() as probe:probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
base=f'http://127.0.0.1:{port}'
environment=os.environ.copy();environment['XDG_CONFIG_HOME']=str(root/'xdg-config');environment['XDG_CACHE_HOME']=str(root/'xdg-cache')
archive=root/'ldm-firefox.zip'
source=Path(__file__).resolve().parents[2]/'extension'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as output:
    for path in source.iterdir():
        if not path.is_file() or path.name in ('manifest.json','manifest.firefox.json'):continue
        if path.suffix in ('.js','.html','.css','.svg','.png','.json'):output.write(path,path.name)
    output.write(source/'manifest.firefox.json','manifest.json')
log=(root/'geckodriver.log').open('w')
process=subprocess.Popen([str(args.geckodriver.resolve()),'--host','127.0.0.1','--port',str(port),
                          '--profile-root',str(root),'--allow-system-access','--log','error'],env=environment,stdout=log,stderr=log)
session=None
def command(path,data=None,method=None):
    return json_request(f'{base}/session/{session}{path}',data,method)['value']
def execute(script,*args):return command('/execute/sync',{'script':script,'args':list(args)})
def async_execute(script,*args):return command('/execute/async',{'script':script,'args':list(args)})
def screenshot(name):
    (artifacts/name).write_bytes(base64.b64decode(command('/screenshot')))
def shadow_text():return execute("return document.querySelector('.ldm-download-overlay-root')?.shadowRoot?.textContent || ''")
def shadow_click(selector,contains=None):
    execute("const root=document.querySelector('.ldm-download-overlay-root').shadowRoot;const nodes=[...root.querySelectorAll(arguments[0])];const node=arguments[1]?nodes.find(e=>e.textContent.includes(arguments[1])):nodes[0];if(!node)throw new Error('Control not found');node.click();",selector,contains)
try:
    wait(lambda:json_request(base+'/status')['value']['ready'],'geckodriver startup')
    uuid='773f5232-55aa-4c7f-bd90-4d6ad2042474'
    created=json_request(base+'/session',{'capabilities':{'alwaysMatch':{
        'browserName':'firefox','acceptInsecureCerts':False,
        'moz:firefoxOptions':{'binary':str(args.firefox.resolve()),'args':['-headless'],
            'prefs':{'extensions.webextensions.uuids':json.dumps({'ldm-media-downloader@localhost':uuid}),
                     'browser.shell.checkDefaultBrowser':False,'browser.startup.homepage':'about:blank'}}}}})['value']
    session=created['sessionId'];report['version']=created['capabilities']['browserVersion']
    report['profile']=created['capabilities'].get('moz:profile')
    installed=command('/moz/addon/install',{'path':str(archive),'temporary':True})
    assert installed=='ldm-media-downloader@localhost',installed
    report['extensionId']=installed
    command('/timeouts',{'script':15000,'pageLoad':25000,'implicit':0})
    command('/window/rect',{'width':1280,'height':900})
    popup_url=f'moz-extension://{uuid}/popup.html'
    command('/url',{'url':popup_url})
    popup_handle=command('/window')
    tab=async_execute("const done=arguments[arguments.length-1];browser.tabs.create({url:arguments[0],active:true}).then(done,error=>done({error:String(error)}));",fixture['source']+'/watch')
    assert 'id' in tab,tab
    wait(lambda:len(command('/window/handles'))==2,'fixture browser tab')
    media_handle=next(handle for handle in command('/window/handles') if handle!=popup_handle)
    command('/window',{'handle':media_handle})
    wait(lambda:bool(execute("return document.querySelector('.ldm-download-overlay-root')")),'installed Firefox player overlay')
    wait(lambda:execute("return document.querySelector('video').readyState>=2"),'Firefox video metadata')
    shadow_click('.ldm-trigger')
    wait(lambda:'protected.mp4' in shadow_text(),'Firefox protected media detection')
    screenshot('ldm-firefox-detection.png')
    shadow_click('.ldm-download','Download')
    direct=wait(lambda:new_job(lambda j:j['status']=='completed' and j['filename'].startswith('protected')),'Firefox Cookie/Referer direct download')
    data=(Path(fixture['download_dir'])/direct['filename']).read_bytes()
    assert hashlib.sha256(data).hexdigest()==fixture['video_sha256']
    report['outputs'].append(direct['filename'])
    report['checks'].append('actual temporary Firefox add-on; player detection; Cookie/Referer direct transfer and SHA-256')

    command('/url',{'url':fixture['source']+'/watch-slow'})
    wait(lambda:bool(execute("return document.querySelector('.ldm-download-overlay-root')")),'slow overlay')
    shadow_click('.ldm-trigger');wait(lambda:'slow.mp4' in shadow_text(),'slow source detection');shadow_click('.ldm-download','Download')
    slow=wait(lambda:new_job(lambda j:j['status']=='downloading' and j['filename'].startswith('slow') and j['bytes_downloaded']>0),'slow download start')
    shadow_click('.ldm-pause','Pause');wait(lambda:job(slow['id'])['status']=='paused','Firefox Pause');screenshot('ldm-firefox-paused.png')
    shadow_click('.ldm-pause','Resume');wait(lambda:job(slow['id'])['status']=='downloading','Firefox Resume')
    shadow_click('.ldm-download','Cancel');wait(lambda:job(slow['id'])['status']=='cancelled','Firefox Cancel')
    assert not (Path(fixture['download_dir'])/slow['filename']).exists()
    report['checks'].append('actual overlay Pause/Resume/Cancel and output cleanup')

    command('/url',{'url':fixture['source']+'/watch-hls'})
    wait(lambda:bool(execute("return document.querySelector('.ldm-download-overlay-root')")),'playlist overlay')
    shadow_click('.ldm-trigger');wait(lambda:'master.m3u8' in shadow_text(),'HLS discovery');shadow_click('.ldm-download','Choose')
    wait(lambda:bool(execute("return document.querySelector('.ldm-download-overlay-root')?.shadowRoot.querySelector('.media-options')")),'actual HLS chooser')
    values=execute("return [...document.querySelector('.ldm-download-overlay-root').shadowRoot.querySelector('[aria-label=\"Video quality\"]').options].map(o=>({value:o.value,label:o.textContent}))")
    assert any('180p' in value['label'] for value in values) and any('360p' in value['label'] for value in values),values
    quality=next(value['value'] for value in values if '360p' in value['label'])
    execute("const r=document.querySelector('.ldm-download-overlay-root').shadowRoot;for(const [label,value] of [['Video quality',arguments[0]],['File format','mkv']]){const s=r.querySelector('[aria-label=\"'+label+'\"]');s.value=value;s.dispatchEvent(new Event('change',{bubbles:true}));}",quality)
    screenshot('ldm-firefox-quality.png');shadow_click('.ldm-download','Download')
    selected=wait(lambda:new_job(lambda j:j['status']=='completed' and j['filename'].endswith('.mkv')),'Firefox selected HLS download')
    inspected=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(Path(fixture['download_dir'])/selected['filename'])],text=True))
    assert next(s for s in inspected['streams'] if s['codec_type']=='video')['height']==360
    assert any(s['codec_type']=='audio' for s in inspected['streams'])
    report['outputs'].append(selected['filename']);report['checks'].append('real HLS quality/audio chooser and 360p MKV+audio output')

    command('/window',{'handle':popup_handle})
    command('/url',{'url':popup_url})
    async_execute("const done=arguments[arguments.length-1];browser.tabs.update(arguments[0],{active:true}).then(()=>{document.getElementById('refresh').click();done(true)},e=>done(String(e)));",tab['id'])
    wait(lambda:execute("return document.getElementById('transfers').textContent.includes(arguments[0])",selected['filename']),'Firefox popup history')
    execute("const row=[...document.querySelectorAll('.stream-card')].find(e=>e.querySelector('.stream-name').textContent==='master.m3u8');if(!row)throw new Error('Manifest popup card missing');row.querySelector('.download-button').click();")
    wait(lambda:execute("return !![...document.querySelectorAll('.stream-card')].find(e=>e.querySelector('.stream-name').textContent==='master.m3u8')?.querySelector('.media-options')"),'Firefox popup quality picker')
    execute("const row=[...document.querySelectorAll('.stream-card')].find(e=>e.querySelector('.stream-name').textContent==='master.m3u8');for(const [label,value] of [['Save','audio'],['File format','mp3']]){const s=row.querySelector('[aria-label=\"'+label+'\"]');s.value=value;s.dispatchEvent(new Event('change',{bubbles:true}));}if(row.querySelector('.badge').textContent!=='Audio only')throw new Error('Incorrect audio-only badge');row.querySelector('.download-button').click();")
    audio_only=wait(lambda:new_job(lambda j:j['status']=='completed' and j['filename'].endswith('.mp3')),'Firefox popup MP3 conversion')
    audio_info=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(Path(fixture['download_dir'])/audio_only['filename'])],text=True))
    assert len(audio_info['streams'])==1 and audio_info['streams'][0]['codec_type']=='audio' and audio_info['streams'][0]['codec_name']=='mp3'
    report['outputs'].append(audio_only['filename']);report['checks'].append('actual popup Audio only/MP3 conversion and accurate selection badge')
    screenshot('ldm-firefox-popup.png')
    report['checks'].append('actual popup transfer history')
    execute("setTimeout(()=>browser.runtime.reload(),50);return true")
    time.sleep(1)
    command('/url',{'url':popup_url})
    wait(lambda:execute("const t=document.getElementById('transfers')?.textContent||'';return t.includes(arguments[0])&&t.includes(arguments[1]);",direct['filename'],selected['filename']),'extension reload/history recovery')
    screenshot('ldm-firefox-popup-recovery.png');report['checks'].append('actual Firefox extension reload and persistent history recovery')
    report['status']='passed'
except Exception as error:
    import traceback
    report['status']='failed';report['failure']=traceback.format_exc()
    if session:
        try:screenshot('ldm-firefox-failure.png')
        except Exception:pass
finally:
    if session:
        try:command('',method='DELETE')
        except Exception:pass
    process.terminate()
    try:process.wait(timeout=5)
    except subprocess.TimeoutExpired:process.kill();process.wait()
    log.close()
    (artifacts/'ldm-firefox-live-report.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report,indent=2))
if report['status']!='passed':raise SystemExit(1)
