#!/usr/bin/env python3
"""Generate an offline, reviewable Stalwart 0.16.27 patch; never contact a server."""
import argparse
import copy
import ipaddress
import json
import re
import sys

VERSION = "0.16.27"
LISTENER = "else-relay"
FIELDS = {
    "MtaStageAuth": {"require": "remote_ip != '{source}'", "saslMechanisms": "0"},
    "MtaStageMail": {"isSenderAllowed": "{authorized}"},
    "MtaStageRcpt": {"allowRelaying": "{authorized}", "maxRecipients": "1"},
    "MtaStageData": {"maxMessages": "1", "maxMessageSize": "65536"},
    "MtaInboundSession": {"maxDuration": "60s", "timeout": "15s", "transferLimit": "262144"},
}

def private_ip(value):
    ip = ipaddress.IPv4Address(value)
    if not any(ip in ipaddress.IPv4Network(net) for net in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")):
        raise ValueError("an exact RFC1918 IPv4 address is required")
    return str(ip)

def generate(existing, source, server, sender, version):
    if version != VERSION:
        raise ValueError("unsupported Stalwart schema version")
    source, server = private_ip(source), private_ip(server)
    if source == server:
        raise ValueError("distinct Else and Stalwart addresses are required")
    sender = sender.lower()
    if len(sender) > 254 or not re.fullmatch(r"[a-z0-9][a-z0-9._+%-]*@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}", sender):
        raise ValueError("use a simple ASCII application sender")
    authorized = f"remote_ip = '{source}' && is_tls && sender = '{sender}'"
    updates = {}
    for kind, fields in FIELDS.items():
        obj = existing[kind]
        # Only changed properties are emitted; retain every original branch/fallback.
        patch = {}
        for name, result in fields.items():
            expression = copy.deepcopy(obj[name])
            if set(expression) != {"match", "else"} or not isinstance(expression["match"], dict) or not isinstance(expression["else"], str):
                raise ValueError("export complete expression match/else values first")
            rows = expression["match"]
            if not all(key.isdigit() and 0 <= int(key) <= 4294967295 and str(int(key)) == key for key in rows):
                raise ValueError("invalid expression ordering")
            ordered = [rows[key] for key in sorted(rows, key=int)]
            if not all(isinstance(row, dict) and set(row) == {"if", "then"} and all(isinstance(value, str) for value in row.values()) for row in ordered):
                raise ValueError("invalid expression branch")
            if any(LISTENER in str(row) for row in ordered) or LISTENER in expression["else"]:
                raise ValueError("review existing relay policy instead of layering duplicate rules")
            expression["match"] = {str(index): row for index, row in enumerate([
                {"if": f"listener = '{LISTENER}'", "then": result.format(source=source, authorized=authorized)}, *ordered
            ])}
            patch[name] = expression
        updates[kind] = patch
    return {"version":VERSION, "update":updates, "create": {
        "NetworkListener": {
            "name":LISTENER, "bind":{f"{server}:10025":True}, "protocol":"smtp",
            "useTls":True, "tlsImplicit":False, "tlsTimeout":10000, "maxConnections":2,
            # A nonempty override avoids inheriting broadly trusted PROXY sources.
            "overrideProxyTrustedNetworks":{"192.0.2.1/32":True},
        },
        "MtaInboundThrottle": {
            "enable":True, "description":"Else dedicated connection budget",
            "key":{"listener":True,"remoteIp":True},
            "match":{"match":{},"else":f"listener = '{LISTENER}'"},
            "rate":{"count":20,"period":60000},
        },
    }}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version",required=True)
    parser.add_argument("--else-ip",required=True)
    parser.add_argument("--stalwart-ip",required=True)
    parser.add_argument("--sender",required=True)
    args=parser.parse_args()
    try:
        raw=sys.stdin.buffer.read(262145)
        if len(raw)>262144: raise ValueError("policy input is too large")
        result=generate(json.loads(raw),args.else_ip,args.stalwart_ip,args.sender,args.version)
    except (ValueError,KeyError,TypeError):
        raise SystemExit("Invalid or incompatible policy export; no settings were changed.")
    print(json.dumps(result,indent=2))

if __name__=="__main__": main()
