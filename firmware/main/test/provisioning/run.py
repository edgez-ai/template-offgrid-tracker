#!/usr/bin/env python3
"""Run the real provisioning endpoint/events against in-memory NVS and cJSON."""
from pathlib import Path
import subprocess
import tempfile

firmware = Path(__file__).resolve().parents[3]
cjson = Path.home() / ".platformio/packages/framework-espidf/components/json/cJSON"
source = (firmware / "main/halow_provisioning.c").read_text()
source = "\n".join(line for line in source.splitlines() if not line.startswith("#include"))
with tempfile.TemporaryDirectory() as directory:
    temporary = Path(directory)
    (temporary / "provisioning.inc").write_text(source)
    (temporary / "esp_err.h").write_text("""
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_ERR_INVALID_ARG 1
#define ESP_ERR_NOT_FOUND 2
#define ESP_ERR_NO_MEM 3
#define ESP_ERR_NVS_NOT_FOUND 4
#define ESP_ERR_NVS_NO_FREE_PAGES 5
#define ESP_ERR_NVS_NEW_VERSION_FOUND 6
""")
    subprocess.run([
        "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-Wno-deprecated-declarations",
        "-fsanitize=address,undefined",
        f"-I{temporary}", f"-I{cjson}", f"-I{firmware / 'main/include'}",
        str(Path(__file__).with_name("test.c")), str(cjson / "cJSON.c"),
        "-o", str(temporary / "test"),
    ], check=True)
    subprocess.run([str(temporary / "test")], check=True)
    wifi = (firmware / "main/wifi_mqtt.c").read_text()
    (temporary / "wifi.inc").write_text("\n".join(
        line for line in wifi.splitlines() if not line.startswith("#include")))
    subprocess.run([
        "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-fsanitize=address,undefined",
        f"-I{temporary}", f"-I{firmware / 'main/include'}",
        str(Path(__file__).with_name("test_wifi.c")), "-o", str(temporary / "wifi-test"),
    ], check=True)
    subprocess.run([str(temporary / "wifi-test")], check=True)
