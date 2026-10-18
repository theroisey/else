#!/usr/bin/env python3
"""Native/actual-image MCP interoperability and bounded workload rehearsal.
Only explicitly owned disposable storage is created. No provider/production data.
"""
import argparse
import base64
import concurrent.futures
from datetime import datetime, timezone
import hashlib
import http.cookiejar
import json
import math
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent.parent
MODERN = '2026-07-28'
LEGACY = '2025-11-25'

REPORT_CLIENT='ca111111-1111-4111-8111-111111111111'
REPORT_CONNECTION='ca222222-2222-4222-8222-222222222222'
def report_fixture():
    """Explicitly synthetic completed Meta report; no credentials or provider job is queued."""
    stamp=datetime.now(timezone.utc).isoformat(timespec='microseconds').replace('+00:00','Z')
    workspace={'report':{'client_id':REPORT_CLIENT,'connection_id':REPORT_CONNECTION,'graph_version':'v26.0','currency':'USD','timezone':'Europe/Istanbul','since':'2026-10-01','until':'2026-10-06','days':[],'totals':{'spend_decimal':'0','impressions':'0','clicks':'0','ctr_percent':None,'cpc_decimal':None,'cpm_decimal':None},'attribution_status':'unavailable'},'collected_from':stamp,'collected_through':stamp}
    raw=json.dumps(workspace,separators=(',',':'))
    quote=lambda value:"'"+value.replace("'","''")+"'"
    return f"""INSERT INTO client_scopes(id) VALUES('{REPORT_CLIENT}');
INSERT INTO clients(id,name,created_at,updated_at) VALUES('{REPORT_CLIENT}','Synthetic MCP report brand',utc_now(),utc_now());
INSERT INTO integration_connections(id,client_id,provider,provider_account_id,state,revision,generation,created_at,updated_at) VALUES('{REPORT_CONNECTION}','{REPORT_CLIENT}','meta_ads','987654321','connected',1,1,utc_now(),utc_now());
INSERT INTO analytics_sync_jobs(id,client_id,connection_id,requested_by,provider,since,until,connection_revision,generation,credential_revision,state,attempts,revision,created_at,updated_at,finished_at) SELECT 'ca333333-3333-4333-8333-333333333333','{REPORT_CLIENT}','{REPORT_CONNECTION}',id,'meta_ads','2026-10-01','2026-10-06',1,1,1,'succeeded',1,1,utc_now(),utc_now(),utc_now() FROM users WHERE email='mcp-test@example.com';
INSERT INTO analytics_snapshots(id,client_id,connection_id,generation,provider,since,until,workspace,workspace_sha256,revision,synced_at) VALUES('ca444444-4444-4444-8444-444444444444','{REPORT_CLIENT}','{REPORT_CONNECTION}',1,'meta_ads','2026-10-01','2026-10-06',{quote(raw)},sha256({quote(raw)}),1,utc_now());"""

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def docker(*args, **kw):
    return subprocess.run([os.environ.get('DOCKER', 'docker'), *args], check=True, **kw)

def run(args):
    with tempfile.TemporaryDirectory(prefix='else-browser-mcp-') as temporary:
        directory = Path(temporary)
        directory.chmod(0o700)
        (directory/'.fixture-control').write_bytes(b'disposable-synthetic-browser-fixture')
        with socket.socket() as selected:
            selected.bind(('127.0.0.1', 0))
            port = selected.getsockname()[1]
        origin = f'http://127.0.0.1:{port}'
        environment = os.environ.copy()
        for key in ('INTEGRATION_KEYRING_FILE', 'INTEGRATION_KEYRING_MODE'):
            environment.pop(key, None)
        environment.update(HTTP_ADDRESS=f'127.0.0.1:{port}', DATABASE_PATH=str(directory/'else.sqlite3'), FRONTEND_DIRECTORY=str(args.frontend.resolve()), AUTH_PUBLIC_ORIGIN=origin, AUTH_COOKIE_SECURE='false')
        bootstrap = {'email':'mcp-test@example.com','display_name':'Synthetic MCP owner','password':'synthetic-mcp-test-password'}
        container = None
        volume = None
        process = None
        common = ['--read-only','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777','--cap-drop=ALL','--security-opt=no-new-privileges','--memory=256m','--cpus=2','-e','AUTH_PUBLIC_ORIGIN='+origin,'-e','AUTH_COOKIE_SECURE=false']
        try:
            if args.image:
                suffix = uuid.uuid4().hex
                container = 'else-mcp-test-'+suffix
                common += ['--user',f'{os.getuid()}:{os.getgid()}','--mount',f'type=bind,src={directory},dst=/testdata','-e','DATABASE_PATH=/testdata/else.sqlite3']
                if args.benchmark_output:
                    common += ['--mount',f'type=bind,src={args.runtime_fixture.resolve()},dst=/runtime-fixture,readonly']
                docker('run','--rm','--interactive',*common,args.image,'bootstrap',input=json.dumps(bootstrap),text=True,capture_output=True,timeout=30)
                if args.benchmark_output:
                    seed_env=environment.copy();seed_env['AUTH_TEST_DIRECTORY']=str(directory)
                    subprocess.run([str(args.fixture.resolve())],input=report_fixture(),text=True,env=seed_env,check=True,capture_output=True,timeout=20)
                docker('run','--detach','--name',container,*common,'--publish',f'127.0.0.1:{port}:8080',args.image,stdout=subprocess.DEVNULL)
            else:
                subprocess.run([str(args.binary.resolve()),'bootstrap'],input=json.dumps(bootstrap),text=True,env=environment,check=True,capture_output=True,timeout=20)
                if args.benchmark_output:
                    seed_env=environment.copy();seed_env['AUTH_TEST_DIRECTORY']=str(directory)
                    subprocess.run([str(args.fixture.resolve())],input=report_fixture(),text=True,env=seed_env,check=True,capture_output=True,timeout=20)
                log=(directory/'server.log').open('wb')
                process=subprocess.Popen([str(args.binary.resolve()),'serve'],env=environment,stdout=log,stderr=subprocess.STDOUT)
            cookies=http.cookiejar.CookieJar()
            browser=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(cookies),NoRedirect())
            machine=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
            def request(path, method='GET', payload=None, expected=200, headers=None, form=False, authenticated=False):
                fields=dict(headers or {})
                raw=None
                if payload is not None:
                    raw=urllib.parse.urlencode(payload).encode() if form else json.dumps(payload).encode()
                    fields['Content-Type']='application/x-www-form-urlencoded' if form else 'application/json'
                if authenticated and method!='GET':
                    fields['Origin']=origin
                    csrf=next((c.value for c in cookies if c.name=='else_csrf'),'')
                    if csrf:
                        fields['X-CSRF-Token']=csrf
                req=urllib.request.Request(origin+path,data=raw,headers=fields,method=method)
                try:
                    response=(browser if authenticated else machine).open(req,timeout=6)
                except urllib.error.HTTPError as error:
                    response=error
                with response:
                    data=response.read()
                    assert response.status in (expected if isinstance(expected,tuple) else (expected,)), f'HTTP status {response.status}, expected {expected} ({method} {path.split("?")[0]})'
                    if path=='/mcp' or path.startswith('/oauth/'):
                        assert 'no-store' in response.headers.get('Cache-Control',''), 'private MCP response cacheable'
                    assert response.headers.get('X-Content-Type-Options')=='nosniff'
                    return (json.loads(data) if data and response.headers.get('Content-Type','').startswith('application/json') else data),response.headers
            deadline=time.monotonic()+20
            while True:
                try:
                    if process:
                        assert process.poll() is None,'owned MCP server exited during startup'
                    request('/ready')
                    break
                except (urllib.error.URLError,TimeoutError,ConnectionResetError):
                    assert time.monotonic()<deadline,'MCP test server readiness failed'
                    time.sleep(.05)
            request('/api/v1/auth/login','POST',{'email':bootstrap['email'],'password':bootstrap['password']},authenticated=True)
            api=lambda path,method='GET',payload=None,expected=200:request('/api/v1/'+path,method,payload,expected,authenticated=True)[0]
            client=REPORT_CLIENT if args.benchmark_output else api('clients','POST',{'name':'Synthetic MCP client'},201)['data']['id']
            other=api('clients','POST',{'name':'Unrelated synthetic client'},201)['data']['id']
            for n in range(5):
                api(f'clients/{client}/websites','POST',{'name':f'Synthetic site {n+1}','url':f'https://site-{n+1}.example/'},201)
            status=api('mcp')['data']
            api('mcp/settings','PUT',{'enabled':True,'expected_revision':status['revision']})
            app=api('mcp/applications','POST',{'name':'Independent interoperability client','redirect_uris':['http://127.0.0.1:9876/callback'],'origins':['https://mcp-client.example']})['data']['id']
            def authorize(scopes, bound=None):
                verifier='v'*64
                challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
                params={'response_type':'code','client_id':app,'redirect_uri':'http://127.0.0.1:9876/callback','resource':origin+'/mcp','scope':scopes,'state':'synthetic-state','code_challenge':challenge,'code_challenge_method':'S256'}
                _,headers=request('/oauth/authorize?'+urllib.parse.urlencode(params),expected=302,authenticated=True)
                authorization=headers['Location'].rsplit('/',1)[1]
                pending=api('mcp/authorizations/'+authorization)['data']
                assert pending['application_name']=='Independent interoperability client'
                result=api('mcp/authorizations/'+authorization,'POST',{'approve':True,'scopes':scopes.split(' '),'client_id':bound})['data']
                query=urllib.parse.parse_qs(urllib.parse.urlsplit(result['redirect_url']).query)
                assert query['state']==['synthetic-state'] and query['iss']==[origin]
                tokens,_=request('/oauth/token','POST',{'grant_type':'authorization_code','client_id':app,'redirect_uri':params['redirect_uri'],'resource':origin+'/mcp','code':query['code'][0],'code_verifier':verifier},form=True)
                return tokens
            _,cors=request('/oauth/token','OPTIONS',expected=204,headers={'Origin':'https://mcp-client.example','Access-Control-Request-Method':'POST'})
            assert cors.get('Access-Control-Allow-Origin')=='https://mcp-client.example'
            token=authorize(' '.join(status['scopes']))
            def rpc(method,params=None,credentials=token,expected=200):
                params=dict(params or {})
                params['_meta']={'io.modelcontextprotocol/protocolVersion':MODERN,'io.modelcontextprotocol/clientCapabilities':{}}
                headers={'Authorization':'Bearer '+credentials['access_token'],'Accept':'application/json, text/event-stream','MCP-Protocol-Version':MODERN,'Mcp-Method':method}
                name=params.get('name',params.get('uri'))
                if name is not None:
                    headers['Mcp-Name']=name
                value,_=request('/mcp','POST',{'jsonrpc':'2.0','id':1,'method':method,'params':params},expected,headers)
                return value
            request('/mcp','POST',{'jsonrpc':'2.0','id':1,'method':'ping'},401,{'Accept':'application/json, text/event-stream'})
            _,challenge_headers=request('/mcp','POST',{},401)
            assert '/.well-known/oauth-protected-resource/mcp' in challenge_headers['WWW-Authenticate']
            metadata,_=request('/.well-known/oauth-protected-resource/mcp')
            assert metadata['resource']==origin+'/mcp'
            assert rpc('server/discover')['result']['supportedVersions']==[MODERN,LEGACY]
            args_client={'client_id':client}
            result=rpc('tools/call',{'name':'else_clients_get','arguments':args_client})['result']
            assert result['structuredContent']['data']['id']==client
            assert not result.get('isError',False)
            limited=authorize('clients:read',client)
            page=rpc('tools/call',{'name':'else_clients_list','arguments':{}},limited)['result']['structuredContent']['data']
            assert [v['id'] for v in page['data']]==[client]
            denied=rpc('tools/call',{'name':'else_clients_get','arguments':{'client_id':other}},limited)['result']
            assert denied['isError'] is True
            assert rpc('tools/call',{'name':'else_finance_summary','arguments':args_client},limited,expected=403)['error']['data']['reason']=='insufficient_scope'
            # Financial reads traverse real OAuth/JSON-RPC and keep the brand ceiling.
            charge=api(f'clients/{client}/billing','POST',{'description':'Synthetic MCP financial source','currency':'EUR','amount_minor':'70000'},201)['data']
            api(f'clients/{other}/billing','POST',{'description':'Unrelated synthetic financial source','currency':'EUR','amount_minor':'99000'},201)
            api(f"clients/{client}/billing/{charge['id']}/payments",'POST',{'command_id':str(uuid.uuid4()),'expected_revision':'1','amount_minor':'35000','currency':'EUR','paid_on':datetime.now(timezone.utc).date().isoformat(),'method':'bank_transfer'})
            financial=authorize('clients:read finance:read',client)
            financial_args={'query':{'currency':'EUR'}}
            for tool in ('else_financial_dashboard','else_financial_receivables','else_financial_payments','else_financial_clients'):
                result=rpc('tools/call',{'name':tool,'arguments':financial_args},financial)['result']
                assert result.get('isError') is not True, f'{tool} failed'
                report=result['structuredContent']['data']
                assert report['client_id']==client
                if tool=='else_financial_dashboard':
                    assert report['position']['amount_minor']=='70000' and report['position']['outstanding_minor']=='35000'
                else:
                    assert len(report['data'])==1
                    assert (report['data'][0]['id'] if tool=='else_financial_clients' else report['data'][0]['client_id'])==client
            assert rpc('tools/call',{'name':'else_financial_dashboard','arguments':financial_args},limited,expected=403)['error']['data']['reason']=='insufficient_scope'
            # Full upstream client supplies its own framing, request context and decoders.
            subprocess.run([str(args.client.resolve())],input=json.dumps({'endpoint':origin+'/mcp','access_token':token['access_token'],'client_id':client}),text=True,check=True,timeout=35)
            # Retrying a real mutation over HTTP returns the same retained receipt.
            command=str(uuid.uuid4())
            creation={'client_id':client,'command_id':command,'input':{'title':'Synthetic retained MCP task'}}
            first=rpc('tools/call',{'name':'else_tasks_create','arguments':creation})['result']['structuredContent']['data']
            assert first['status']=='committed'
            assert rpc('tools/call',{'name':'else_tasks_create','arguments':creation})['result']['structuredContent']['data']==first
            if args.benchmark_output:
                # Populate a realistic small portfolio, with no provider calls.
                for n in range(48):
                    api('clients','POST',{'name':f'Synthetic benchmark brand {n+1}'},201)
                for n in range(35):
                    api(f'clients/{client}/tasks','POST',{'title':f'Synthetic workload {n+1}'},201)
                def usage():
                    if process:
                        try:
                            stat=Path(f'/proc/{process.pid}/stat').read_text().split()
                            status_text=Path(f'/proc/{process.pid}/status').read_text()
                            memory=next(int(line.split()[1])*1024 for line in status_text.splitlines() if line.startswith('VmHWM:'))
                            return {'cpu_seconds':(int(stat[13])+int(stat[14]))/os.sysconf('SC_CLK_TCK'),'peak_rss_bytes':memory}
                        except (OSError,StopIteration):
                            return None
                    raw=docker('exec',container,'/runtime-fixture','process-usage',capture_output=True,text=True).stdout
                    return json.loads(raw)
                def evict():
                    if container:
                        docker('exec',container,'/runtime-fixture','cache-flush',stdout=subprocess.DEVNULL)
                    else:
                        # The owned native server refuses startup when another Redis owns this port.
                        with socket.create_connection(('127.0.0.1',6379),timeout=2) as sock:
                            sock.sendall(b'*2\r\n$7\r\nFLUSHDB\r\n$4\r\nSYNC\r\n')
                            assert sock.recv(128)==b'+OK\r\n'
                report_args={'client_id':client,'id':REPORT_CONNECTION,'provider':'meta_ads','from':'2026-10-01','to':'2026-10-06'}
                measured=rpc('tools/call',{'name':'else_analytics_report','arguments':report_args})['result']['structuredContent']['data']
                assert measured['status']['state']=='succeeded' and measured['data']['totals']['spend_decimal']=='0'
                assert measured['data']['totals']['ctr_percent'] is None
                search_args={'query':{'q':'benchmark','limit':'5'}}
                search_first=rpc('tools/call',{'name':'else_clients_list','arguments':search_args})['result']['structuredContent']['data']
                search_args['query']['cursor']=search_first['page']['next_cursor']
                assert search_args['query']['cursor']
                revoked=authorize('clients:read',client)
                request('/oauth/revoke','POST',{'client_id':app,'token':revoked['access_token']},form=True)
                cases=[
                    ('native_rest',lambda:api('clients/'+client),200,None,[1,8]),
                    ('mcp_discovery',lambda:rpc('server/discover'),200,None,[1,8]),
                    ('mcp_tool_listing',lambda:rpc('tools/list'),200,None,[1,8]),
                    ('mcp_resource_listing',lambda:rpc('resources/list'),200,None,[1,8]),
                    ('mcp_resource_read',lambda:rpc('resources/read',{'uri':'else://clients/'+client}),200,None,[1,8]),
                    ('mcp_client',lambda:rpc('tools/call',{'name':'else_clients_get','arguments':args_client}),200,None,[1,8]),
                    ('mcp_tasks',lambda:rpc('tools/call',{'name':'else_tasks_list','arguments':args_client}),200,None,[1,8]),
                    ('mcp_financial_dashboard',lambda:rpc('tools/call',{'name':'else_financial_dashboard','arguments':financial_args},financial),200,None,[1,8]),
                    ('mcp_search_page',lambda:rpc('tools/call',{'name':'else_clients_list','arguments':search_args}),200,None,[1,8]),
                    ('mcp_scope_denial',lambda:rpc('tools/call',{'name':'else_finance_summary','arguments':args_client},limited,expected=403),403,None,[1,8]),
                    ('mcp_revoked_token',lambda:rpc('ping',credentials=revoked,expected=401),401,None,[1,8]),
                    ('mcp_report_cache_hit',lambda:rpc('tools/call',{'name':'else_analytics_report','arguments':report_args}),200,None,[1,8]),
                    ('mcp_report_cache_miss',lambda:rpc('tools/call',{'name':'else_analytics_report','arguments':report_args}),200,evict,[1]),
                    ('mcp_task_mutation',lambda:rpc('tools/call',{'name':'else_tasks_create','arguments':{'client_id':client,'command_id':str(uuid.uuid4()),'input':{'title':'Synthetic measured MCP task'}}}),200,None,[1,8]),
                ]
                measurements=[]
                for label,load,expected_status,prepare,levels in cases:
                    for concurrency in levels:
                        for _ in range(3):
                            load()
                        before=usage();start=time.perf_counter()
                        def sample(_):
                            if prepare:
                                prepare()
                            began=time.perf_counter()
                            try:
                                value=load()
                                if label.startswith('mcp_'):
                                    if expected_status==200:
                                        assert 'result' in value and value['result'].get('isError') is not True
                                    else:
                                        assert 'error' in value
                                return (time.perf_counter()-began)*1000,False
                            except Exception:
                                return (time.perf_counter()-began)*1000,True
                        with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
                            samples=list(pool.map(sample,range(50)))
                        elapsed=time.perf_counter()-start;after=usage();values=sorted(v for v,_ in samples)
                        pct=lambda p:round(values[max(0,math.ceil(p*len(values))-1)],3)
                        row={'workload':label,'expected_status':expected_status,'concurrency':concurrency,'requests':len(samples),'failures':sum(f for _,f in samples),'p50_ms':pct(.5),'p95_ms':pct(.95),'p99_ms':pct(.99),'throughput_rps':round(len(samples)/elapsed,2),'before':before,'after':after}
                        if prepare:
                            row['notes']='Owned cache eviction is excluded from latency; wall throughput includes eviction. Serialized cold-cache runs only.'
                        if before and after and 'cpu_seconds' in before and 'cpu_seconds' in after:
                            row['server_cpu_fraction']=round((after['cpu_seconds']-before['cpu_seconds'])/elapsed,3)
                        measurements.append(row)
                barrier=__import__('threading').Barrier(64)
                def burst(_):
                    barrier.wait(timeout=10)
                    value=rpc('tools/list',expected=(200,503))
                    return 'accepted' if 'result' in value else 'shed' if value.get('error',{}).get('data',{}).get('reason')=='service_unavailable' else 'unexpected'
                with concurrent.futures.ThreadPoolExecutor(max_workers=64) as pool:
                    burst_results=list(pool.map(burst,range(64)))
                overload={key:burst_results.count(key) for key in ['accepted','shed','unexpected']};overload['concurrency']=64
                report={'image':args.image,'image_id':docker('inspect','--format','{{.Image}}',container,capture_output=True,text=True).stdout.strip() if container else None,'binary_sha256':None if args.image else hashlib.sha256(args.binary.read_bytes()).hexdigest(),'fixture':{'clients':50,'websites_per_target':5,'initial_tasks_per_target':36,'provider_data':'Explicit synthetic completed Meta report; no provider credentials or external requests.','measured_task_mutations':100,'additional_mutation_warmups':6},'limits':'Short loopback rehearsal, 50 samples per case; p99 is the observed maximum. Not an SLA or live Cloudflare measurement. HTTP client and CPU scheduling overhead are included. CPU/RSS are cumulative counters for the Rust application process (Redis excluded); CPU has kernel clock-tick granularity. Default image nonroot UID is independently verified by the container gate; this test shares the host fixture UID.','measurements':measurements,'overload':overload}
                args.benchmark_output.parent.mkdir(parents=True,exist_ok=True)
                args.benchmark_output.write_text(json.dumps(report,indent=2)+'\n')
                assert all(row['failures']==0 for row in measurements),'MCP workload failures'
                assert overload['unexpected']==0,'unexpected overload response'
            metrics=api('mcp/metrics')['data']
            assert int(metrics['http']['requests'])>0 and metrics['tools']
            renewed,_=request('/oauth/token','POST',{'grant_type':'refresh_token','client_id':app,'resource':origin+'/mcp','refresh_token':limited['refresh_token']},form=True)
            request('/oauth/token','POST',{'grant_type':'refresh_token','client_id':app,'resource':origin+'/mcp','refresh_token':limited['refresh_token']},400,form=True)
            rpc('ping',credentials=renewed,expected=401)
            print('Native MCP/OAuth HTTP, scoped records, refresh replay, retained mutation and independent-client checks passed'+(' against the actual image.' if args.image else '.'))
        finally:
            if process and process.poll() is None:
                process.send_signal(signal.SIGTERM)
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill();process.wait(timeout=5)
                assert process.returncode==0,'native MCP test server did not stop cleanly'
            if container:
                docker('rm','--force',container,stdout=subprocess.DEVNULL)
            if volume:
                docker('volume','rm',volume,stdout=subprocess.DEVNULL)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary',type=Path,default=ROOT/'build/roisey-else')
    parser.add_argument('--frontend',type=Path,default=ROOT/'frontend/dist')
    parser.add_argument('--client',type=Path,default=ROOT/'target/mcp-client/debug/else-mcp-interoperability')
    parser.add_argument('--image')
    parser.add_argument('--fixture',type=Path,default=ROOT/'target/debug/examples/browser-fixture')
    parser.add_argument('--runtime-fixture',type=Path,default=ROOT/'build/runtime-fixture')
    parser.add_argument('--benchmark-output',type=Path)
    run(parser.parse_args())
