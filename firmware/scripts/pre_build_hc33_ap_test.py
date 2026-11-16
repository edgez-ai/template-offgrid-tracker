"""Select the isolated official-Morse HC33 AP test and local Kconfig literals."""
Import("env")
import os
from pathlib import Path
project = Path(env.subst("$PROJECT_DIR")).resolve()
local = project / "sdkconfig.defaults.ht-hc33-ap-test.local"
if not local.is_file():
    print("ERROR: Create sdkconfig.defaults.ht-hc33-ap-test.local with the test SSID/password")
    env.Exit(1)
for values in (os.environ, env["ENV"]):
    values["OFFGRID_HC33_AP_TEST"] = "1"
    values["SDKCONFIG_DEFAULTS"] = ";".join(map(str, (
        project / "sdkconfig.defaults.ht-hc33-ap-test", local)))

# PlatformIO compiles ordinary CMake libraries but omits the official SDK's
# custom archive merge/mangling target. Build it before ESP-IDF's linker script
# generator needs that archive, using the upstream build rule unchanged.
def build_official_morse_archive(source, target, env):
    import subprocess
    ninja = str(Path(env.PioPlatform().get_package_dir("tool-ninja")) / "ninja")
    subprocess.check_call([ninja, "-C", env.subst("$BUILD_DIR"), "morselib_build"],
                          env=env["ENV"])

archive = "$BUILD_DIR/esp-idf/halow/components/morselib/libmorse.a"
archive_node = env.Command(archive, [], build_official_morse_archive)
env.AlwaysBuild(archive_node)
env.Depends(archive_node, [
    "$BUILD_DIR/esp-idf/halow/components/morselib/liblibmorse.a",
    "$BUILD_DIR/esp-idf/halow/components/hostap/libmmhostap.a",
])
env.Depends("$BUILD_DIR/sections.ld", archive_node)
env.Append(LIBS=[env.File(archive)])
