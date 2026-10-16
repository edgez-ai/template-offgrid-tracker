#!/usr/bin/env python3
"""Select the standalone nRF54L15 + FGH200M all-off benchmark app."""

Import("env")

import shlex
from pathlib import Path


project_dir = Path(env.subst("$PROJECT_DIR")).resolve()
env.Replace(
    PROJECT_SRC_DIR=str(project_dir / "benchmarks" / "fgh200m_all_off" / "src")
)

extra_conf = env.GetProjectOption("custom_zephyr_extra_conf", "")
if extra_conf:
    extra_conf_path = (project_dir / extra_conf).resolve()
    board = env.BoardConfig()
    cmake_args = board.get("build.zephyr.cmake_extra_args", "")
    board.update(
        "build.zephyr.cmake_extra_args",
        cmake_args + " " + shlex.quote("-DCONF_FILE=" + str(extra_conf_path)),
    )

print("Building standalone FGH200M all-sensors-off System OFF benchmark")
