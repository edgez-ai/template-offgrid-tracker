if(CONFIG_DAB_RAW_RF_TEST)
    set(component_sources "raw_rf_main.c")
    set(component_private_dependencies
        halow
        esp_timer
        usb
    )
    if(CONFIG_DAB_WIFI_EXTENDER)
        list(APPEND component_sources
            "wifi_extender.c"
            "extender_dns.c"
            "edgez_mesh_internet.c"
            "edgez_mesh_iperf.c"
            "edgez_mesh_alfred.c"
            "edgez_mesh_gateway_policy.c"
            "edgez_mesh_ndp.c")
        list(APPEND component_private_dependencies
            esp_event
            esp_netif
            esp_wifi
            nvs_flash)
        if(IDF_TARGET STREQUAL "esp32p4")
            list(APPEND component_private_dependencies espressif__esp_hosted)
        endif()
    endif()
else()
    set(component_sources
        "app_main.c"
    )

    if(CONFIG_OFFGRID_MESH_PS_TEST)
        list(APPEND component_sources "mesh_ps_test.c")
    endif()

    if(CONFIG_HALOW_PAWR_ENABLE)
        list(APPEND component_sources "halow_pawr.c")
    endif()

    if(CONFIG_DAB_START_MQTT_RELAY)
        list(APPEND component_sources "halow_telemetry.c")
    endif()

    set(component_private_dependencies
        esp_event
        esp_netif
        halow
        esp_adc
        esp_app_format
        esp_driver_gpio
        esp_timer
    )

    if(CONFIG_DAB_WIFI_EXTENDER)
        list(APPEND component_sources
            "wifi_extender.c"
            "extender_dns.c"
            "edgez_mesh_internet.c"
            "edgez_mesh_iperf.c"
            "edgez_mesh_alfred.c"
            "edgez_mesh_gateway_policy.c"
            "edgez_mesh_ndp.c")
    endif()

# ESP32-S3 uses its local BLE controller. ESP32-P4 uses the ESP32-C6
# controller on the Waveshare board through ESP-Hosted.
    if(IDF_TARGET STREQUAL "esp32s3" OR IDF_TARGET STREQUAL "esp32p4")
        list(APPEND component_sources "halow_provisioning.c")
        list(APPEND component_private_dependencies
            bt
            esp_wifi
            json
            network_provisioning
            nvs_flash
        )
    endif()

    if(IDF_TARGET STREQUAL "esp32p4")
        if(CONFIG_DAB_FACTORY_RESET_BUTTON)
            list(APPEND component_sources "factory_reset_button.c")
        endif()
        list(APPEND component_private_dependencies espressif__esp_hosted)
    endif()
endif()

list(APPEND component_private_dependencies nanopb)

idf_component_register(
    SRCS ${component_sources}
    INCLUDE_DIRS "include"
    PRIV_REQUIRES ${component_private_dependencies}
)

if(CONFIG_OFFGRID_MESH_PS_TEST)
    # Software reset can leave an MM6108 GPIO interrupt pending on ESP32-S3.
    # Replace the upstream HAL init with the hardened test-local variant so the
    # GPIO ISR service cannot start while IRQ/BUSY still have stale status.
    get_target_property(shims_sources shims SOURCES)
    list(FILTER shims_sources EXCLUDE REGEX "mmhal_os\\.c$")
    set_property(TARGET shims PROPERTY SOURCES "${shims_sources}")
    target_sources(shims PRIVATE
        "${CMAKE_CURRENT_LIST_DIR}/mmhal_os_ps_override.c")
endif()

if(IDF_TARGET STREQUAL "esp32p4" AND NOT CONFIG_DAB_RAW_RF_TEST)
    # ESP-Hosted 1.4 starts SDIO unconditionally from a constructor. Keep the
    # component linked for BLE provisioning, but let app_main initialize it
    # only when no saved HaLow profile exists. This keeps SDIO inactive while
    # the provisioned path enumerates the MM8108 USB adapter.
    idf_component_get_property(esp_hosted_lib espressif__esp_hosted COMPONENT_LIB)
    get_target_property(esp_hosted_sources ${esp_hosted_lib} SOURCES)
    list(FILTER esp_hosted_sources EXCLUDE REGEX "esp_hosted_host_init\\.c$")
    set_property(TARGET ${esp_hosted_lib} PROPERTY SOURCES "${esp_hosted_sources}")
endif()
