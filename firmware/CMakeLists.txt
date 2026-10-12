cmake_minimum_required(VERSION 3.16)

# PlatformIO entry point; platform-specific source and archive selection is
# delegated to the embedded ESP HaLow component tree below.
list(APPEND EXTRA_COMPONENT_DIRS
    "${CMAKE_CURRENT_LIST_DIR}/platforms/esp-halow/halow"
    "${CMAKE_CURRENT_LIST_DIR}/shared/nanopb"
)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(mm8108_halow_usb)
