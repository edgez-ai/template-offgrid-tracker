cmake_minimum_required(VERSION 3.16)

# PlatformIO entry point; platform-specific source and archive selection is
# delegated to the embedded ESP HaLow component tree below.
if("$ENV{OFFGRID_HC33_AP_TEST}" STREQUAL "1")
    list(APPEND EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/platforms/esp-halow-official/halow")
else()
list(APPEND EXTRA_COMPONENT_DIRS
    "${CMAKE_CURRENT_LIST_DIR}/platforms/esp-halow/halow"
    "${CMAKE_CURRENT_LIST_DIR}/shared/nanopb"
)

endif()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(mm8108_halow_usb)
