"""Private controlled SMTP for owned synthetic native/container integration fixtures."""
import json
import atexit
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]

class MailFixture:
    def __init__(self, container_mode=False):
        self.container = None
        self.received = {}
        self.process = None
        self.path = Path(tempfile.gettempdir()) / ('else-otp-' + uuid.uuid4().hex)
        self.port = 2525
        if not container_mode:
            with socket.socket() as choice:
                choice.bind(('127.0.0.1', 0))
                self.port = choice.getsockname()[1]
        atexit.register(self.close)
        self.environment = {'SMTP_HOST':'127.0.0.1','SMTP_PORT':str(self.port),'SMTP_SECURITY':'none','SMTP_FROM_ADDRESS':'fixture@example.com','SMTP_USERNAME':'','SMTP_PASSWORD':'','SMTP_PASSWORD_FILE':'','SMTP_FROM_NAME':'Roisey Else','SMTP_TIMEOUT_SECONDS':'2'}

    def start(self, container=None, directory="/var/lib/roisey-else"):
        self.container = container
        if container:
            self.binary = directory + '/.smtp-fixture'
            helper=ROOT/'build/runtime-fixture'
            helper.chmod(0o755)
            self._docker('cp',str(helper),container+':'+self.binary,stdout=subprocess.DEVNULL)
            self._docker('exec','--detach',container,self.binary,'smtp',str(self.path),str(self.port))
        else:
            target=Path(os.environ.get('CARGO_TARGET_DIR',str(ROOT/'target')))
            if not target.is_absolute():
                target=ROOT/target
            self.binary = target/'debug/examples/runtime-fixture'
            if not self.binary.is_file():
                self.binary=ROOT/'build/runtime-fixture'
            self.process = subprocess.Popen([str(self.binary),'smtp',str(self.path),str(self.port)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        if not container:
            deadline=time.monotonic()+5
            while not (self.path/"ready").exists():
                if self.process.poll() is not None or time.monotonic()>deadline:
                    raise AssertionError("Controlled SMTP fixture failed to start")
                time.sleep(.02)
        return self

    @staticmethod
    def _docker(*args, **kwargs):
        return subprocess.run([os.environ.get('DOCKER','docker'),*args],check=True,**kwargs)

    def code(self, email):
        deadline = time.monotonic()+10
        while time.monotonic()<deadline:
            if self.container:
                value=json.loads(self._docker('exec',self.container,self.binary,'smtp-read',str(self.path),email,capture_output=True,text=True).stdout.strip())
            else:
                try:
                    value=json.loads((self.path/'messages.json').read_text()).get(email,{})
                except (FileNotFoundError,json.JSONDecodeError):
                    value={}
            code=value.get('code','')
            received=value.get('received_at',0)
            if len(code)==6 and code.isdigit() and received>self.received.get(email,0):
                self.received[email]=received
                return code
            time.sleep(.05)
        raise AssertionError('Controlled SMTP fixture did not receive a code')

    def close(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=5)
        if not self.container and self.path.exists():
            import shutil
            shutil.rmtree(self.path)
