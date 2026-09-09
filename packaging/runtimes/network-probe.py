"""Test-only MCP: exercise the guest's actual curl/proxy path."""
import json
import socket
import subprocess
import sys

for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request["method"]
    result = {}
    if method == "initialize":
        result = {"protocolVersion": request["params"]["protocolVersion"],
                  "capabilities": {"tools": {}},
                  "serverInfo": {"name": "network-probe", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [{"name": "probe", "description": "Test HTTPS egress",
                            "inputSchema": {"type": "object", "properties": {}}}]}
    elif method == "tools/call":
        arguments = request["params"].get("arguments", {})
        args = [sys.argv[1], "--silent", "--show-error", "--max-time", "10",
                "--output", "/dev/null", "--write-out", "%{http_code}"]
        if arguments.get("direct"):
            with socket.socket() as connection:
                connection.settimeout(2)
                try:
                    connection.connect(("1.1.1.1", 443))
                    errno = 0
                except OSError as error:
                    errno = error.errno
            result = {"content": [{"type": "text", "text": json.dumps({"errno": errno})}]}
            print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
            continue
        output = subprocess.run(args + [arguments["url"]], capture_output=True, text=True)
        result = {"content": [{"type": "text", "text": json.dumps({
            "code": output.returncode, "status": output.stdout, "error": output.stderr})}]}
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
