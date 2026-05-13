# Blender headless addon installer for the new MSI Blender.
#
# Invoked as:
#   blender --background --python setup-blender-addons.py -- [addon-zip-or-py paths...]
#
# Each path after `--` is one of:
#   - path to a .zip (downloaded from GitHub releases of a packaged addon/extension)
#   - path to a .py file (single-file legacy addon, like blender-mcp's addon.py)
#
# The script:
#   1) Installs each via the appropriate Blender API (addon_install / extensions API)
#   2) Enables the resulting module
#   3) Saves user prefs so the addon stays enabled on next launch
#   4) Logs everything to stdout for the TS wrapper to surface
#
# Designed to be idempotent — re-running it just re-enables already-installed addons.

import bpy
import os
import sys
import addon_utils

argv = sys.argv
if "--" in argv:
    user_argv = argv[argv.index("--") + 1:]
else:
    user_argv = []

if not user_argv:
    print("usage: blender --background --python setup-blender-addons.py -- <path1> [path2] ...")
    sys.exit(1)

print(f"=== installing {len(user_argv)} addons ===")
print(f"Blender version: {bpy.app.version_string}")
print(f"User scripts dir: {bpy.utils.user_resource('SCRIPTS')}")
print(f"User extensions dir: {bpy.utils.user_resource('EXTENSIONS')}")

installed_modules: list[str] = []

for path in user_argv:
    print(f"\n--- {path} ---")
    if not os.path.exists(path):
        print(f"  ERR: file not found, skipping")
        continue

    ext = os.path.splitext(path)[1].lower()

    if ext == ".py":
        # Legacy single-file addon (e.g. blender-mcp's addon.py)
        # bpy.ops.preferences.addon_install copies the file into the user
        # scripts/addons dir and registers it.
        try:
            res = bpy.ops.preferences.addon_install(filepath=path, overwrite=True)
            print(f"  addon_install: {res}")
        except Exception as e:
            print(f"  addon_install failed: {e}")
            continue

        # Derive module name from filename (Blender's installer keeps the basename
        # minus .py — e.g. addon.py → module 'addon').
        module = os.path.splitext(os.path.basename(path))[0]
        try:
            bpy.ops.preferences.addon_enable(module=module)
            print(f"  enabled: {module}")
            installed_modules.append(module)
        except Exception as e:
            print(f"  enable failed: {e}")

    elif ext == ".zip":
        # Could be either:
        #   a) Legacy addon zip (top-level __init__.py + bl_info dict)
        #   b) Extension zip (top-level blender_manifest.toml — Blender 4.2+)
        # bpy.ops.preferences.addon_install handles (a). For (b) we use the
        # new extensions ops. Detect by inspecting the zip contents.
        try:
            import zipfile
            with zipfile.ZipFile(path) as zf:
                names = zf.namelist()
                is_extension = any(n.endswith("blender_manifest.toml") for n in names)
        except Exception as e:
            print(f"  zip read failed: {e}")
            continue

        if is_extension:
            # Use the modern extensions API. Install into the user repo.
            try:
                res = bpy.ops.extensions.package_install_files(
                    filepath=path,
                    repo="user_default",
                    enable_on_install=True,
                )
                print(f"  extensions.package_install_files: {res}")
                installed_modules.append(os.path.basename(path))
            except Exception as e:
                print(f"  extension install failed: {e}")
        else:
            try:
                res = bpy.ops.preferences.addon_install(filepath=path, overwrite=True)
                print(f"  addon_install (zip): {res}")
            except Exception as e:
                print(f"  addon_install (zip) failed: {e}")
                continue
            # Derive module name by inspecting the zip's top-level dir
            try:
                import zipfile
                with zipfile.ZipFile(path) as zf:
                    tops = {n.split("/")[0] for n in zf.namelist() if "/" in n}
                module = next(iter(tops)) if tops else None
                if module:
                    bpy.ops.preferences.addon_enable(module=module)
                    print(f"  enabled: {module}")
                    installed_modules.append(module)
                else:
                    print("  WARN: could not infer module name from zip; please enable manually")
            except Exception as e:
                print(f"  enable failed: {e}")

    else:
        print(f"  unsupported extension '{ext}', expected .py or .zip")
        continue

# Persist the enabled-state so the addons stay on next Blender launch.
try:
    bpy.ops.wm.save_userpref()
    print(f"\n✓ saved userpref")
except Exception as e:
    print(f"\n  save_userpref failed: {e}")

print(f"\n=== done. installed/enabled: {len(installed_modules)} ===")
for m in installed_modules:
    print(f"  - {m}")

# Final listing — what's actually enabled?
print("\n=== all enabled addons (post-install) ===")
for addon in bpy.context.preferences.addons:
    print(f"  - {addon.module}")
