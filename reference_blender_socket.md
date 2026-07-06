---
name: reference-blender-socket
description: Blender MCP socket protocol — message format for direct localhost:9876 access when MCP tool unavailable in conversation context
metadata:
  type: reference
---

# Blender Socket Protocol (port 9876)

When `mcp__blend007-blender__*` tools are not registered in conversation context, connect directly via TCP socket at `localhost:9876`.

## Message format

```python
import socket, json, time

def blender_call(cmd_type, wait=3, timeout=30, **params):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    s.connect(('127.0.0.1', 9876))
    payload = {'type': cmd_type, 'params': params}  # NOTE: params is nested dict
    s.sendall(json.dumps(payload).encode())
    time.sleep(wait)
    data = b''
    s.settimeout(timeout)
    try:
        while True:
            chunk = s.recv(131072)
            if not chunk:
                break
            data += chunk
            try:
                json.loads(data.decode())
                break  # stop when valid JSON received
            except:
                pass
    except:
        pass
    s.close()
    return json.loads(data.decode()) if data else {}
```

## Commands

- `get_scene_info` — returns list of objects (name, type, location). Hard-capped at 10 objects in result. Use execute_code for full enumeration.
- `execute_code` — run Python in Blender. Params: `{"code": "..."}`. Returns `{"status":"success","result":{"executed":true,"result":"<stdout>"}}`.
- `get_viewport_screenshot` — capture viewport. Params: `{"filepath": "C:/path/to/output.png"}`. Returns `{"status":"success","result":{"success":true,"width":N,"height":N,"filepath":"..."}}`.

## Important gotchas

- `params` MUST be a nested dict, NOT top-level fields. `{"type":"execute_code","code":"..."}` fails. `{"type":"execute_code","params":{"code":"..."}}` works.
- `get_viewport_screenshot` requires a `filepath` param — without it, returns `{"error":"No filepath provided"}`.
- scene_info is capped at 10 objects. Use `execute_code` with `bpy.data.objects` iteration for full scene.
- Blender may be version 5.x — check `blend_method` gotcha for material alpha.
