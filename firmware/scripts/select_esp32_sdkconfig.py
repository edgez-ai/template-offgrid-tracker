import os
from pathlib import Path

Import("env")

project_dir = Path(env.subst("$PROJECT_DIR"))
pio_env = env.subst("$PIOENV")
target = env.BoardConfig().get("build.mcu", "")
target_defaults = project_dir / f"sdkconfig.defaults.{target}"
environment_defaults = project_dir / f"sdkconfig.defaults.{pio_env}"

defaults = [project_dir / "sdkconfig.defaults"]
if target_defaults.is_file():
    defaults.append(target_defaults)
if environment_defaults.is_file():
    defaults.append(environment_defaults)

env["ENV"]["SDKCONFIG_DEFAULTS"] = ";".join(str(path) for path in defaults)
