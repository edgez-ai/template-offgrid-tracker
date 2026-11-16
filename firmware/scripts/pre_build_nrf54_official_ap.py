"""Prepare only the upstream Morse station stack for the local AP test."""
Import("env")
import os
import shlex
from pathlib import Path

project = Path(env.subst("$PROJECT_DIR")).resolve()
module = project / "platforms" / "mm-iot-zephyr-official"
if not (module / "submodules/mm-iot-sdk/framework/morselib/include/mmwlan.h").is_file():
    print("ERROR: Initialize firmware/platforms/mm-iot-zephyr-official recursively")
    env.Exit(1)
credentials = project / "zephyr/fgh200m_ap_test.local.conf"
if not credentials.is_file():
    print("ERROR: Copy zephyr/fgh200m_ap_test.local.conf.example and set local AP credentials")
    env.Exit(1)

env.Replace(PROJECT_SRC_DIR=str(project / "nrf54/src"))
env.setdefault("ENV", {})
for variables in (os.environ, env["ENV"]):
    variables["MORSE_ZEPHYR_MODULE"] = str(module)
    variables["EDGEZ_OFFICIAL_AP_BUILD"] = "1"
    # Do not select the private UMAC or app-supplied Morse binary overrides.
    variables.pop("EDGEZ_HALOW_MESH_SOURCE_ROOT", None)
    variables.pop("MORSE_SM_USE_APP_BINARIES", None)
board = env.BoardConfig()
args = board.get("build.zephyr.cmake_extra_args", "")
board.update("build.zephyr.cmake_extra_args",
             args + " " + shlex.quote("-DEXTRA_CONF_FILE=" + str(credentials)))

# PlatformIO's Zephyr builder does not execute upstream's custom archive and
# firmware-header targets. Execute those dependencies before it reads CMake's
# code model; do not modify any upstream Morse source.
platform = env.PioPlatform()
framework = platform.get_package_dir("framework-zephyr-nrf54l15")
if not framework:
    print("ERROR: Zephyr framework package is not installed")
    env.Exit(1)
builder = Path(framework) / "scripts/platformio/platformio-build.py"
source = builder.read_text(encoding="utf-8")
source = source.replace('env.Append(LIBS=lib_dep["lib_path"])',
                        'env.Append(LIBS=[lib_dep["lib_path"]])')
marker = "# EDGEZ_OFFICIAL_AP_DEPENDENCIES"
if marker not in source:
    anchor = "target_configs = load_target_configurations(codemodel)\n"
    if anchor not in source:
        print("ERROR: Unsupported PlatformIO Zephyr builder layout")
        env.Exit(1)
    source = source.replace(anchor, anchor + '''
# EDGEZ_OFFICIAL_AP_DEPENDENCIES
if os.environ.get("EDGEZ_OFFICIAL_AP_BUILD"):
    ninja = os.path.join(platform.get_package_dir("tool-ninja"), "ninja")
    subprocess.check_call([ninja, "-C", BUILD_DIR, "edgez_ap_test_dependencies"])
    codemodel = get_cmake_code_model(west_manifest)
    target_configs = load_target_configurations(codemodel)
''', 1)
builder.write_text(source, encoding="utf-8")
print("AP test uses official MorseMicro/mm-iot-zephyr and its pinned mm-iot-sdk")
