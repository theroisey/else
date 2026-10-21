#!/usr/bin/env python3
"""Owned, isolated Stalwart policy + Else handoff rehearsal. Never selects live storage."""
import argparse
import base64
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.request
import uuid

ROOT=Path(__file__).resolve().parents[1]
STALWART="stalwartlabs/stalwart@sha256:c429b311c93db5606598abc1c68225a85a6953183848ae01bee9c6a98885836c"
PYTHON="python@sha256:848ba4413eb897e225159b8fc1b02094576cbae4aa73fc13142608ae2c8c0e32"
spec=importlib.util.spec_from_file_location("relay_policy",ROOT/"tools/stalwart-relay-policy.py")
policy=importlib.util.module_from_spec(spec);spec.loader.exec_module(policy)

def docker(*args,**options):
    return subprocess.run([os.environ.get("DOCKER","docker"),*args],check=True,**options)
def output(*args): return docker(*args,capture_output=True,text=True).stdout
def port():
    with socket.socket() as s: s.bind(("127.0.0.1",0));return s.getsockname()[1]
def expression(value): return {"match":{},"else":value}
def baseline():
    return {
        "MtaStageAuth":{"require":expression("local_port != 25"),"saslMechanisms":{"match":{"0":{"if":"local_port != 25 && is_tls","then":"[plain, login]"}},"else":"false"}},
        "MtaStageMail":{"isSenderAllowed":expression("true")},
        "MtaStageRcpt":{"allowRelaying":expression("!is_empty(authenticated_as)"),"maxRecipients":expression("100")},
        "MtaStageData":{"maxMessages":expression("10"),"maxMessageSize":expression("1048576")},
        "MtaInboundSession":{"maxDuration":expression("5m"),"timeout":expression("60s"),"transferLimit":expression("1048576")},
    }

CLIENT=r'''
import json,smtplib,ssl,socket,sys
case,host,relay=sys.argv[1:]
ctx=ssl.create_default_context(cafile='/fixture/cert.pem')
def connection(port=10025,tls=True):
 c=smtplib.SMTP(timeout=10);c.connect(host,port);c._host='mail.relay.test';c.ehlo('client.example.test')
 if tls: c.starttls(context=ctx);c.ehlo('client.example.test')
 return c
if case=='shared':
 try: connection()
 except (OSError,smtplib.SMTPException): print('shared-interface-denied');sys.exit(0)
 raise AssertionError('private listener reachable on shared interface')
if case=='rate':
 denied=False
 for _ in range(22):
  try:
   with smtplib.SMTP(timeout=5) as attempt:
    code,_=attempt.connect(host,10025)
    if code!=220: denied=True;break
  except (smtplib.SMTPConnectError,smtplib.SMTPServerDisconnected): denied=True;break
 assert denied;print('rate-passed');sys.exit(0)
c=connection(25 if case=='public' else 587 if case in ('submission','authenticated') else 10025,tls=case!='plaintext')
if case=='public':
 code,_=c.mail('foreign@example.test')
 if code==250: code,_=c.rcpt('receiver@example.invalid')
 assert code>=400
elif case in ('unauthorized','plaintext','sender','null-sender'):
 code,_=c.mail('' if case=='null-sender' else 'forged@example.test' if case=='sender' else 'noreply@example.test')
 assert code>=400
elif case in ('proxy','trusted-proxy'):
 c.close()
 with socket.create_connection((host,10025),timeout=5) as raw:
  raw.recv(1024)
  raw.sendall(('PROXY TCP4 '+relay+' '+host+' 49152 10025\r\n').encode())
  answer=raw.recv(4096);assert b'250' not in answer
elif case=='limits':
 assert not c.has_extn('auth')
 assert c.mail('noreply@example.test')[0]==250
 assert c.rcpt('receiver@example.invalid')[0]==250
 assert c.rcpt('another@example.invalid')[0]>=400
 c.rset()
 assert c.mail('noreply@example.test',options=['SIZE=70000'])[0]>=400
elif case=='oversize':
 assert c.mail('noreply@example.test')[0]==250
 assert c.rcpt('receiver@example.invalid')[0]==250
 try: code,_=c.data('From: noreply@example.test\r\nTo: receiver@example.invalid\r\n\r\n'+'x'*70000)
 except smtplib.SMTPDataError as failure: code=failure.smtp_code
 assert code>=400
elif case=='submission':
 assert c.has_extn('auth')
 assert c.mail('admin@example.test')[0]>=400
elif case=='authenticated':
 with open('/fixture/recovery-secret') as secret: c.login('admin@example.test',secret.read())
 assert c.mail('admin@example.test')[0]==250
 assert c.rcpt('receiver@example.invalid')[0]==250
 assert c.data('From: admin@example.test\r\nTo: receiver@example.invalid\r\nSubject: Synthetic authenticated fixture\r\n\r\nControlled handoff only.')[0]==250
elif case=='concurrency':
 second=socket.create_connection((host,10025),timeout=5);assert second.recv(1024).startswith(b'220')
 third=socket.create_connection((host,10025),timeout=5)
 assert not third.recv(1024).startswith(b'220')
 third.close();second.close()
elif case=='valid':
 assert not c.has_extn('auth')
 assert c.mail('noreply@example.test')[0]==250
 assert c.rcpt('receiver@example.invalid')[0]==250
 assert c.data('From: noreply@example.test\r\nTo: receiver@example.invalid\r\nSubject: Synthetic fixture only\r\n\r\nControlled handoff; no external delivery.')[0]==250
 try:
  code,_=c.mail('noreply@example.test')
  if code==250: code,_=c.rcpt('receiver@example.invalid')
  if code==250: code,_=c.docmd('DATA')
  assert code>=400
 except smtplib.SMTPServerDisconnected: pass
else: raise AssertionError('unknown case')
c.close();print(case+'-passed')
'''

def run(args):
    name="else-stalwart-test-"+uuid.uuid4().hex
    networks=[];containers=[];checks=[]
    occupied=[]
    ids=output("network","ls","--quiet").split()
    if ids:
        for n in json.loads(output("network","inspect",*ids)):
            occupied.extend(ipaddress.ip_network(x["Subnet"]) for x in (n["IPAM"].get("Config") or []) if x.get("Subnet"))
    subnet=next(ipaddress.ip_network(f"10.217.{i}.0/29") for i in range(1,255) if not any(ipaddress.ip_network(f"10.217.{i}.0/29").overlaps(n) for n in occupied if n.version==4))
    server=str(subnet[2]);source=str(subnet[3]);unauthorized=str(subnet[4])
    with tempfile.TemporaryDirectory(prefix=name) as tmp:
        path=Path(tmp);path.chmod(0o700)
        (path/"config.json").write_text(json.dumps({"@type":"RocksDb","path":"/fixture/stalwart-data"}))
        (path/"client.py").write_text(CLIENT)
        subprocess.run(["openssl","req","-x509","-newkey","rsa:2048","-noenc","-sha256","-days","1","-subj","/CN=mail.relay.test","-addext","subjectAltName=DNS:mail.relay.test","-addext","basicConstraints=critical,CA:FALSE","-addext","extendedKeyUsage=serverAuth","-keyout",str(path/"key.pem"),"-out",str(path/"cert.pem")],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        (path/"key.pem").chmod(0o600)
        recovery=secrets.token_urlsafe(32)
        (path/"recovery-secret").write_text(recovery);(path/"recovery-secret").chmod(0o600)
        (path/"admin.env").write_text("STALWART_RECOVERY_ADMIN=admin@example.test:"+recovery+"\n")
        (path/"admin.env").chmod(0o600)
        auth="Basic "+base64.b64encode(("admin@example.test:"+recovery).encode()).decode()
        admin_port=port();base=f"http://127.0.0.1:{admin_port}"
        def rpc(method,document):
            request=urllib.request.Request(base+"/jmap",json.dumps({"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],"methodCalls":[[method,document,"0"]]}).encode(),{"Content-Type":"application/json","Authorization":auth})
            with urllib.request.urlopen(request,timeout=5) as r: response=json.load(r)["methodResponses"][0]
            if response[0]=="error" or response[1].get("notCreated") or response[1].get("notUpdated"):
                raise RuntimeError("isolated registry operation failed: "+json.dumps(response))
            return response[1]
        def create(kind,value): return rpc("x:"+kind+"/set",{"create":{"fixture":value}})["created"]["fixture"]["id"]
        def start(recovery_mode):
            docker("create","--name",name,"--user",f"{os.getuid()}:{os.getgid()}","--network",networks[1],"--publish",f"127.0.0.1:{admin_port}:8080","--mount",f"type=bind,src={path},dst=/fixture","--env-file",str(path/"admin.env"),"-e","STALWART_HOSTNAME=mail.relay.test","-e","STALWART_RECOVERY_MODE="+str(recovery_mode).lower(),STALWART,"--config","/fixture/config.json",stdout=subprocess.DEVNULL)
            if name not in containers: containers.append(name)
            docker("network","connect","--ip",server,"--alias","mail.relay.test",networks[0],name,stdout=subprocess.DEVNULL)
            docker("start",name,stdout=subprocess.DEVNULL)
            deadline=time.monotonic()+30
            while True:
                try: rpc("x:NetworkListener/get",{});break
                except Exception:
                    if time.monotonic()>deadline: raise RuntimeError("isolated Stalwart startup failed; private logs retained only during this fixture")
                    time.sleep(.2)
        def client(case,ip=source,network=None,destination=None):
            identity=name+"-client"
            command=["run","--rm","--name",identity,"--user",f"{os.getuid()}:{os.getgid()}","--network",network or networks[0],"--mount",f"type=bind,src={path/'client.py'},dst=/fixture/client.py,readonly","--mount",f"type=bind,src={path/'cert.pem'},dst=/fixture/cert.pem,readonly","--read-only","--cap-drop=ALL","--security-opt=no-new-privileges"]
            if case=="authenticated": command += ["--mount",f"type=bind,src={path/'recovery-secret'},dst=/fixture/recovery-secret,readonly"]
            if not network: command += ["--ip",ip]
            command += [PYTHON,"python","/fixture/client.py",case,destination or "mail.relay.test",source]
            docker(*command,stdout=subprocess.DEVNULL)
            checks.append(case)
        try:
            for suffix in ("private","shared"):
                network=name+"-"+suffix
                command=["network","create","--label","roisey.else.test=stalwart-relay"]
                if suffix=="private": command += ["--internal","--subnet",str(subnet)]
                docker(*command,network,stdout=subprocess.DEVNULL);networks.append(network)
            start(True)
            existing=baseline()
            generated=policy.generate(existing,source,server,"noreply@example.test",policy.VERSION)
            create("NetworkListener",{"name":"fixture-admin","protocol":"http","bind":{"0.0.0.0:8080":True}})
            create("NetworkListener",{"name":"smtp","protocol":"smtp","bind":{"0.0.0.0:25":True},"useTls":True,"tlsImplicit":False})
            create("NetworkListener",{"name":"submission","protocol":"smtp","bind":{"0.0.0.0:587":True},"useTls":True,"tlsImplicit":False})
            create("Certificate",{"certificate":{"@type":"File","filePath":"/fixture/cert.pem"},"privateKey":{"@type":"File","filePath":"/fixture/key.pem"}})
            for kind,fields in generated["update"].items(): create(kind,{**existing[kind],**fields})
            for kind,obj in generated["create"].items(): create(kind,obj)
            docker("stop","--time","10",name,stdout=subprocess.DEVNULL)
            docker("rm","--volumes",name,stdout=subprocess.DEVNULL)
            start(False)
            info=json.loads(output("inspect",name))[0]
            assert not info["NetworkSettings"]["Ports"].get("10025/tcp")
            shared_ip=info["NetworkSettings"]["Networks"][networks[1]]["IPAddress"]
            client("valid")
            client("sender")
            client("null-sender")
            client("plaintext")
            client("unauthorized",ip=unauthorized)
            client("proxy",ip=unauthorized)
            client("trusted-proxy")
            client("limits")
            client("oversize")
            client("concurrency")
            client("shared",network=networks[1],destination=shared_ip)
            client("public",network=networks[1],destination=shared_ip)
            client("submission",network=networks[1],destination=shared_ip)
            client("authenticated",network=networks[1],destination=shared_ip)
            client("rate",ip=unauthorized)
            # Ordinary submission still advertises AUTH and requires it. The
            # offline generator preserves its original policies verbatim.
            if args.image:
                app=name+"-app";app_port=port();data=path/"else";data.mkdir(mode=0o700)
                common=["--user",f"{os.getuid()}:{os.getgid()}","--mount",f"type=bind,src={data},dst=/var/lib/roisey-else"]
                docker("run","--rm","--interactive","--network","none",*common,"-e","AUTH_PUBLIC_ORIGIN=http://127.0.0.1:8080","-e","AUTH_COOKIE_SECURE=false",args.image,"bootstrap",input=json.dumps({"email":"recipient@example.invalid","display_name":"Synthetic relay owner"}).encode(),stdout=subprocess.DEVNULL)
                docker("create","--name",app,"--network",networks[1],*common,"--mount",f"type=bind,src={path/'cert.pem'},dst=/fixture-ca.pem,readonly","--read-only","--tmpfs","/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777","--cap-drop=ALL","--security-opt=no-new-privileges","--publish",f"127.0.0.1:{app_port}:8080","-e","AUTH_PUBLIC_ORIGIN=http://127.0.0.1:"+str(app_port),"-e","AUTH_COOKIE_SECURE=false","-e","SMTP_AUTH_MODE=trusted_relay","-e","SMTP_HOST=mail.relay.test","-e","SMTP_RELAY_IP="+server,"-e","SMTP_PORT=10025","-e","SMTP_SECURITY=starttls","-e","SMTP_FROM_ADDRESS=noreply@example.test","-e","SSL_CERT_FILE=/fixture-ca.pem",args.image,stdout=subprocess.DEVNULL);containers.append(app)
                docker("network","connect","--ip",source,networks[0],app,stdout=subprocess.DEVNULL)
                docker("start",app,stdout=subprocess.DEVNULL)
                app_base=f"http://127.0.0.1:{app_port}";deadline=time.monotonic()+25
                while True:
                    try:
                        with urllib.request.urlopen(app_base+"/ready",timeout=2) as r: assert r.status==200
                        break
                    except Exception:
                        if time.monotonic()>deadline: raise RuntimeError("isolated Else startup failed")
                        time.sleep(.1)
                request=urllib.request.Request(app_base+"/api/v1/auth/otp/request",json.dumps({"email":"recipient@example.invalid"}).encode(),{"Content-Type":"application/json","Origin":app_base})
                with urllib.request.urlopen(request,timeout=5) as r: assert r.status==202
                deadline=time.monotonic()+15
                while True:
                    with sqlite3.connect(data/"else.sqlite3") as db:
                        state=db.execute("SELECT state FROM auth_email_outbox").fetchone()
                        assert db.execute("SELECT count(*) FROM sessions").fetchone()[0]==0
                    if state==("sent",): break
                    if state==("failed",) or time.monotonic()>deadline: raise RuntimeError("isolated Else TLS handoff failed")
                    time.sleep(.1)
                checks.append("exact-image-encrypted-otp-handoff-without-session")
            print(json.dumps({"stalwart_version":policy.VERSION,"stalwart_image":STALWART,"checks":checks,"smtp_ports_published":False,"external_mail_delivery_tested":False}))
        finally:
            # Names, networks and directories are generated here. Never select
            # another service, customer volume or existing Docker network.
            for container in reversed(containers):
                subprocess.run([os.environ.get("DOCKER","docker"),"rm","--force","--volumes",container],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            for network in reversed(networks):
                subprocess.run([os.environ.get("DOCKER","docker"),"network","rm",network],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image",help="exact prebuilt Else image; required for the full handoff gate")
    run(parser.parse_args())
