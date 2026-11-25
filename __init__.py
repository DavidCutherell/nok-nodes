"""nok-nodes: a ComfyUI custom node pack that holds several small tools.

Each tool is a subfolder with its own `__init__.py` that exposes
`NODE_CLASS_MAPPINGS` (and optionally `NODE_DISPLAY_NAME_MAPPINGS`). This
file finds those folders and merges them, so adding a tool means adding a
folder. A tool that fails to import is reported and skipped; the others
still load.

Browser code for every tool lives flat in `web/`.
"""

import importlib
import pkgutil
import traceback

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./web"

_NOT_TOOLS = {"tests", "web"}

for _info in pkgutil.iter_modules(__path__):
    if not _info.ispkg or _info.name in _NOT_TOOLS or _info.name.startswith(("_", ".")):
        continue
    try:
        _tool = importlib.import_module(f".{_info.name}", __name__)
    except Exception:
        print(f"[nok-nodes] tool '{_info.name}' failed to load and was skipped:", flush=True)
        traceback.print_exc()
        continue
    for _name in getattr(_tool, "NODE_CLASS_MAPPINGS", {}):
        if _name in NODE_CLASS_MAPPINGS:
            print(f"[nok-nodes] node name '{_name}' is defined twice; '{_info.name}' wins", flush=True)
    NODE_CLASS_MAPPINGS.update(getattr(_tool, "NODE_CLASS_MAPPINGS", {}))
    NODE_DISPLAY_NAME_MAPPINGS.update(getattr(_tool, "NODE_DISPLAY_NAME_MAPPINGS", {}))

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
