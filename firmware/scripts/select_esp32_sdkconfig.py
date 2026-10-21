import os
from pathlib import Path

Import("env")

project_dir = Path(env.subst("$PROJECT_DIR"))
pio_env = env.subst("$PIOENV")
if pio_env.endswith("-bulk-test") and not os.environ.get("EDGEZ_HALOW_MESH_SOURCE_ROOT"):
    sibling_source = project_dir.parent.parent / "edgez-halow-mesh"
    if sibling_source.is_dir():
        source_root = str(sibling_source.resolve())
        os.environ["EDGEZ_HALOW_MESH_SOURCE_ROOT"] = source_root
        env["ENV"]["EDGEZ_HALOW_MESH_SOURCE_ROOT"] = source_root
target = env.BoardConfig().get("build.mcu", "")
target_defaults = project_dir / f"sdkconfig.defaults.{target}"
environment_defaults = project_dir / f"sdkconfig.defaults.{pio_env}"

defaults = [project_dir / "sdkconfig.defaults"]
if target_defaults.is_file():
    defaults.append(target_defaults)
if environment_defaults.is_file():
    defaults.append(environment_defaults)

env["ENV"]["SDKCONFIG_DEFAULTS"] = ";".join(str(path) for path in defaults)
