/*
 * Copyright (c) 2026 EdgeZeron AI AB. All rights reserved.
 * Licensed under the EdgeZ Commercial Software License.
 */

#include <inttypes.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "edgez_umac.h"
#include "edgez_mesh.h"
#include "edgez_mesh_hwmp.h"
#include "edgez_mesh_msdu.h"
#include "edgez_mesh_sae_provider.h"
#include "edgez_umac_mesh_runtime.h"
#include "edgez_rf_api.h"
#include "esp_err.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mm8108_usb.h"
#include "mmhal_os.h"
#include "sdkconfig.h"
#include "usb_host_service.h"
#if CONFIG_DAB_WIFI_EXTENDER
#include "wifi_extender.h"
#endif

static const char *TAG = "edgez_raw_rf";

struct raw_rf_counters
{
    atomic_uint_least32_t tx_submitted;
    atomic_uint_least32_t tx_submit_failed;
    atomic_uint_least32_t tx_status;
    atomic_uint_least32_t tx_status_failed;
    atomic_uint_least32_t tx_status_aggregated;
    atomic_uint_least32_t rx;
    atomic_uint_least32_t protected_rx;
    atomic_uint_least32_t decrypted_rx;
    atomic_uint_least32_t decrypt_failed;
    atomic_uint_least32_t msdu_decoded;
    atomic_uint_least32_t msdu_failed;
    atomic_uint_least32_t batman_received;
    atomic_uint_least32_t batman_transmitted;
    atomic_uint_least32_t batman_tx_failed;
    atomic_uint_least32_t restart;
};

static struct raw_rf_counters counters;
static struct edgez_umac_mesh_runtime mesh_runtime;
static struct edgez_mesh_sae_provider sae_provider;
static struct edgez_mesh_hwmp_state hwmp_state;
static uint8_t pending_peer[EDGEZ_UMAC_MAC_LEN];
static atomic_uint_least32_t pending_peer_timestamp_ms;
static atomic_bool pending_peer_discovery;

static int raw_rx_data(void *ctx, const struct edgez_umac_rx_frame *radio,
                       const struct edgez_mesh_rx_data *frame)
{
    (void)ctx;
    const uint32_t count = atomic_fetch_add(&counters.rx, 1U) + 1U;
    if (count <= 8U)
    {
        ESP_LOGI(TAG,
                 "mesh data RX #%" PRIu32 " peer=%02x:%02x:%02x:%02x:%02x:%02x "
                 "seq=%u tid=%u payload=%u RSSI=%d",
                 count, frame->transmitter[0], frame->transmitter[1],
                 frame->transmitter[2], frame->transmitter[3],
                 frame->transmitter[4], frame->transmitter[5],
                 (unsigned)frame->sequence_number, (unsigned)frame->tid,
                 (unsigned)frame->payload_length, (int)radio->rssi_dbm);
    }
    return EDGEZ_UMAC_OK;
}

static int raw_rx_unsupported(void *ctx,
                              const struct edgez_umac_rx_frame *radio)
{
    (void)ctx;
    static uint32_t logged;
    static uint32_t data_logged;
    static uint32_t ethernet_logged;
    static uint32_t directed_data_logged;
    const uint8_t *frame = radio->data;
    const uint8_t b0 = radio->length > 0U ? frame[0] : 0U;
    const uint8_t b1 = radio->length > 1U ? frame[1] : 0U;
    const uint16_t frame_control = (uint16_t)b0 | ((uint16_t)b1 << 8);
    const bool data_frame = ((frame_control >> 2) & 0x03U) == 2U;
    const bool protected_action =
        (frame_control & 0x00fcU) == 0x00d0U &&
        (frame_control & 0x4000U) != 0U && radio->length >= 40U;
    const bool directed_data_frame =
        data_frame && radio->length >= 10U && (frame[4] & 1U) == 0U;
    const bool ethernet_frame =
        radio->length >= 14U &&
        ((frame[12] == 0x08U && (frame[13] == 0x00U || frame[13] == 0x06U)) ||
         (frame[12] == 0x86U && frame[13] == 0xddU));

    if (protected_action)
    {
        static uint32_t management_logged;
        uint8_t *plaintext = malloc(radio->length);
        if (plaintext != NULL)
        {
            size_t plaintext_length = 0U;
            uint64_t packet_number = 0U;
            uint8_t key_id = 0U;
            const int decrypt = edgez_mesh_sae_provider_decrypt_management(
                &sae_provider, frame, radio->length, plaintext,
                radio->length, &plaintext_length, &packet_number, &key_id);
            const bool log_management = management_logged++ < 16U;
            if (decrypt == EDGEZ_UMAC_OK)
            {
                if (log_management)
                {
                    ESP_LOGI(TAG,
                             "protected action decrypted pn=%" PRIu64
                             " key=%u category=%u action=%u len=%u",
                             packet_number, (unsigned)key_id,
                             plaintext_length > 0U ? plaintext[0] : 0U,
                             plaintext_length > 1U ? plaintext[1] : 0U,
                             (unsigned)plaintext_length);
                    ESP_LOG_BUFFER_HEXDUMP(TAG, plaintext,
                                           plaintext_length, ESP_LOG_INFO);
                }

                if (plaintext_length >= 2U && plaintext[0] == 3U)
                {
                    const int ba_result =
                        edgez_mesh_sae_provider_receive_block_ack_action(
                            &sae_provider, &frame[10], plaintext,
                            plaintext_length);
                    if (ba_result != EDGEZ_UMAC_OK)
                    {
                        ESP_LOGW(TAG, "Block Ack action processing failed: %d",
                                 ba_result);
                    }
                    else if (log_management)
                    {
                        ESP_LOGI(TAG, "Block Ack action handled: %u",
                                 (unsigned)plaintext[1]);
                    }
                }
                else
                {
                    struct edgez_mesh_hwmp_reply reply;
                    uint8_t response[EDGEZ_MESH_HWMP_PREP_ACTION_LEN];
                    if (edgez_mesh_hwmp_process_action(
                            &hwmp_state, sae_provider.local_mac, &frame[10],
                            plaintext, plaintext_length, &reply))
                    {
                        const size_t response_length =
                            edgez_mesh_hwmp_build_prep_action(
                                &reply, response, sizeof(response));
                        const int transmit = response_length == 0U ?
                            EDGEZ_UMAC_INVALID_STATE :
                            edgez_mesh_sae_provider_transmit_action(
                                &sae_provider, reply.next_hop, response,
                                response_length);
                        if (transmit != EDGEZ_UMAC_OK)
                        {
                            ESP_LOGW(TAG, "HWMP PREP transmit failed: %d",
                                     transmit);
                        }
                        else if (log_management)
                        {
                            ESP_LOGI(TAG,
                                     "HWMP PREQ target is local; PREP tx=%d "
                                     "target_seq=%" PRIu32 " origin_seq=%" PRIu32,
                                     transmit, reply.target_sequence,
                                     reply.originator_sequence);
                        }
                    }
                }
            }
            else if (log_management)
            {
                ESP_LOGW(TAG,
                         "protected action decrypt failed: %d len=%u",
                         decrypt, (unsigned)radio->length);
            }
            free(plaintext);
        }
    }

    if (logged++ < 8U || (data_frame && data_logged++ < 8U) ||
        (directed_data_frame && directed_data_logged++ < 16U) ||
        (ethernet_frame && ethernet_logged++ < 8U))
    {
        ESP_LOGI(TAG,
                 "unsupported RF frame len=%u fc=%02x%02x RSSI=%d noise=%d "
                 "freq=%" PRIu32 " bw=%u channel=%u vif=%u decrypted=%u",
                 (unsigned)radio->length, b1, b0, (int)radio->rssi_dbm,
                 (int)radio->noise_dbm, radio->frequency_hz,
                 (unsigned)radio->bandwidth_mhz,
                 (unsigned)radio->driver_channel,
                 (unsigned)radio->vif_id, radio->decrypted ? 1U : 0U);
        ESP_LOG_BUFFER_HEXDUMP(TAG, frame, radio->length, ESP_LOG_INFO);
    }
    return EDGEZ_UMAC_OK;
}

static int raw_rx_protected_data(
    void *ctx, const struct edgez_umac_rx_frame *radio,
    const struct edgez_mesh_rx_protected_data *frame)
{
    (void)ctx;
    const uint32_t count = atomic_fetch_add(&counters.protected_rx, 1U) + 1U;
    if (count <= 8U)
    {
        ESP_LOGI(TAG,
                 "protected mesh RX #%" PRIu32 " len=%u header=%u addr4=%u "
                 "tid=%u seq=%u ccmp=%u RSSI=%d decrypted=%u",
                 count, (unsigned)radio->length,
                 (unsigned)frame->mac_header_length,
                 frame->has_address4 ? 1U : 0U, (unsigned)frame->tid,
                 (unsigned)frame->sequence_number,
                 (unsigned)frame->ccmp_body_length, (int)radio->rssi_dbm,
                 radio->decrypted ? 1U : 0U);
        ESP_LOG_BUFFER_HEXDUMP(TAG, radio->data, radio->length, ESP_LOG_INFO);
    }

    uint8_t *plaintext = malloc(frame->ccmp_body_length);
    if (plaintext == NULL)
    {
        atomic_fetch_add(&counters.decrypt_failed, 1U);
        return EDGEZ_UMAC_NO_CAPACITY;
    }
    size_t plaintext_length = 0U;
    uint64_t packet_number = 0U;
    const int decrypt = edgez_mesh_sae_provider_decrypt_data(
        &sae_provider, frame, plaintext, frame->ccmp_body_length,
        &plaintext_length, &packet_number);
    if (decrypt == EDGEZ_UMAC_OK)
    {
        const uint32_t decrypted =
            atomic_fetch_add(&counters.decrypted_rx, 1U) + 1U;
        if (decrypted <= 8U)
        {
            ESP_LOGI(TAG,
                     "decrypted mesh RX #%" PRIu32 " pn=%" PRIu64
                     " tid=%u plaintext=%u",
                     decrypted, packet_number, (unsigned)frame->tid,
                     (unsigned)plaintext_length);
            ESP_LOG_BUFFER_HEXDUMP(TAG, plaintext, plaintext_length,
                                   ESP_LOG_INFO);
        }
        struct edgez_mesh_msdu msdu;
        const int decode = edgez_mesh_msdu_decode(
            &msdu, frame->destination, frame->source,
            plaintext, plaintext_length);
        if (decode == EDGEZ_UMAC_OK)
        {
            const uint32_t decoded =
                atomic_fetch_add(&counters.msdu_decoded, 1U) + 1U;
            if (decoded <= 8U)
            {
                ESP_LOGI(TAG,
                         "mesh MSDU type=0x%04x payload=%u da="
                         "%02x:%02x:%02x:%02x:%02x:%02x sa="
                         "%02x:%02x:%02x:%02x:%02x:%02x",
                         msdu.ether_type, (unsigned)msdu.payload_length,
                         msdu.destination[0], msdu.destination[1],
                         msdu.destination[2], msdu.destination[3],
                         msdu.destination[4], msdu.destination[5],
                         msdu.source[0], msdu.source[1], msdu.source[2],
                         msdu.source[3], msdu.source[4], msdu.source[5]);
            }
            if (msdu.ether_type == EDGEZ_BATADV_ETHERTYPE)
            {
                const size_t ethernet_capacity =
                    EDGEZ_ETHERNET_HEADER_LEN + msdu.payload_length;
                uint8_t *ethernet = malloc(ethernet_capacity);
                size_t ethernet_length = 0U;
                if (ethernet != NULL &&
                    edgez_mesh_msdu_to_ethernet(
                        &msdu, ethernet, ethernet_capacity,
                        &ethernet_length) == EDGEZ_UMAC_OK &&
                    edgez_mesh_receive_ethernet(
                        ethernet, ethernet_length,
                        frame->transmitter))
                {
                    atomic_fetch_add(&counters.batman_received, 1U);
                }
                free(ethernet);
            }
        }
        else
        {
            atomic_fetch_add(&counters.msdu_failed, 1U);
            ESP_LOGW(TAG, "mesh MSDU decode failed: %d", decode);
        }
    }
    else
    {
        atomic_fetch_add(&counters.decrypt_failed, 1U);
        if (count <= 8U)
        {
            ESP_LOGW(TAG, "protected mesh decrypt failed: %d", decrypt);
        }
    }
    free(plaintext);
    if (edgez_mesh_peering_manager_find(
            &mesh_runtime.peering_manager, frame->transmitter) == NULL)
    {
        memcpy(pending_peer, frame->transmitter, EDGEZ_UMAC_MAC_LEN);
        atomic_store_explicit(&pending_peer_timestamp_ms,
                              radio->timestamp_ms, memory_order_relaxed);
        atomic_store_explicit(&pending_peer_discovery, true,
                              memory_order_release);
    }
    return EDGEZ_UMAC_OK;
}

static int raw_rx_qos_null(void *ctx,
                           const struct edgez_umac_rx_frame *radio,
                           const struct edgez_mesh_rx_qos_null *frame)
{
    (void)ctx;
    static uint32_t logged;
    if (logged++ < 4U)
    {
        ESP_LOGI(TAG,
                 "mesh QoS Null peer=%02x:%02x:%02x:%02x:%02x:%02x "
                 "seq=%u tid=%u eosp=%u RSSI=%d",
                 frame->transmitter[0], frame->transmitter[1],
                 frame->transmitter[2], frame->transmitter[3],
                 frame->transmitter[4], frame->transmitter[5],
                 (unsigned)frame->sequence_number, (unsigned)frame->tid,
                 frame->end_of_service_period ? 1U : 0U,
                 (int)radio->rssi_dbm);
    }
    return EDGEZ_UMAC_OK;
}

static void raw_tx_status(void *ctx, const struct edgez_umac_tx_status *status)
{
    (void)ctx;
    const uint32_t count = atomic_fetch_add(&counters.tx_status, 1U) + 1U;
    const bool failed =
        (status->status_flags & EDGEZ_RF_TX_STATUS_FAILED) != 0U;
    if ((status->status_flags & EDGEZ_RF_TX_STATUS_AGGREGATED) != 0U)
    {
        atomic_fetch_add(&counters.tx_status_aggregated, 1U);
    }
    if (failed)
    {
        const uint32_t failed_count =
            atomic_fetch_add(&counters.tx_status_failed, 1U) + 1U;
        /* A congested link can report hundreds of failures per second. Keep
         * the cumulative counter authoritative and sample the UART output so
         * diagnostics do not become part of the performance bottleneck. */
        if (failed_count <= 16U || (failed_count % 128U) == 0U)
        {
            ESP_LOGW(TAG, "TX failure #%" PRIu32 " status #%" PRIu32
                     " token=%" PRIuPTR " flags=0x%02x attempts=%u",
                     failed_count, count, status->token,
                     status->status_flags, status->attempts);
        }
    }
    else if (count <= 16U || (count % 1024U) == 0U)
    {
        ESP_LOGI(TAG, "TX status #%" PRIu32 " token=%" PRIuPTR
                 " flags=0x%02x attempts=%u",
                 count, status->token, status->status_flags,
                 status->attempts);
    }
}

static void raw_tx_pause(void *ctx, uint16_t sources_mask, bool paused)
{
    (void)ctx;
    ESP_LOGW(TAG, "TX %s sources=0x%04x", paused ? "paused" : "resumed",
             sources_mask);
}

static void raw_hardware_restart(void *ctx)
{
    (void)ctx;
    atomic_fetch_add(&counters.restart, 1U);
    ESP_LOGE(TAG, "RF backend requested a hardware restart");
}

static const struct edgez_umac_mesh_runtime_events raw_event_ops = {
    .data = raw_rx_data,
    .protected_data = raw_rx_protected_data,
    .qos_null = raw_rx_qos_null,
    .unsupported = raw_rx_unsupported,
    .tx_status = raw_tx_status,
    .tx_pause_changed = raw_tx_pause,
    .hardware_restart_required = raw_hardware_restart,
};

static bool private_mesh_get_local_mac(void *ctx, uint8_t mac[6])
{
    const struct edgez_umac_mesh_runtime *runtime = ctx;
    if (runtime == NULL || mac == NULL ||
        runtime->umac.state != EDGEZ_UMAC_STATE_RUNNING)
    {
        return false;
    }
    memcpy(mac, runtime->radio_info.mac_addr, EDGEZ_UMAC_MAC_LEN);
    return true;
}

static size_t private_mesh_snapshot_peers(void *ctx, uint8_t (*peers)[6],
                                          size_t capacity)
{
    const struct edgez_umac_mesh_runtime *runtime = ctx;
    if (runtime == NULL || peers == NULL)
    {
        return 0U;
    }
    size_t count = 0U;
    for (size_t i = 0; i < EDGEZ_UMAC_MAX_PEERS && count < capacity; ++i)
    {
        const struct edgez_umac_peer *peer = &runtime->umac.peers[i];
        if (peer->in_use && peer->state == EDGEZ_UMAC_PEER_AUTHORIZED)
        {
            memcpy(peers[count++], peer->mac_addr, EDGEZ_UMAC_MAC_LEN);
        }
    }
    return count;
}

static esp_err_t private_mesh_transmit(void *ctx, const uint8_t *frame,
                                       size_t frame_len,
                                       const uint8_t receiver[6],
                                       uint8_t tid, uint32_t timeout_ms)
{
    (void)ctx;
    (void)timeout_ms;
    const int result = edgez_mesh_sae_provider_transmit_ethernet(
        &sae_provider, receiver, frame, frame_len, tid);
    if (result == EDGEZ_UMAC_OK)
    {
        atomic_fetch_add(&counters.batman_transmitted, 1U);
        return ESP_OK;
    }
    atomic_fetch_add(&counters.batman_tx_failed, 1U);
    if (result == EDGEZ_UMAC_NO_CAPACITY)
    {
        return ESP_ERR_NO_MEM;
    }
    if (result == EDGEZ_UMAC_NOT_FOUND)
    {
        return ESP_ERR_NOT_FOUND;
    }
    return ESP_FAIL;
}

static const edgez_mesh_transport_ops_t private_mesh_transport = {
    .get_local_mac = private_mesh_get_local_mac,
    .snapshot_authorized_peers = private_mesh_snapshot_peers,
    .transmit_ethernet = private_mesh_transmit,
};

static int start_raw_radio(struct edgez_umac_mesh_runtime *runtime,
                           struct edgez_umac_radio_info *info)
{
    esp_err_t err = usb_host_service_start();
    if (err != ESP_OK)
    {
        ESP_LOGE(TAG, "USB host startup failed: %s", esp_err_to_name(err));
        return EDGEZ_UMAC_DRIVER_ERROR;
    }
    err = mm8108_usb_start();
    if (err != ESP_OK)
    {
        ESP_LOGE(TAG, "MM8108 USB startup failed: %s", esp_err_to_name(err));
        return EDGEZ_UMAC_DRIVER_ERROR;
    }

    ESP_LOGI(TAG, "Waiting for MM8108 USB adapter");
    uint32_t waited_ms = 0U;
    while (!mm8108_usb_is_ready())
    {
        vTaskDelay(pdMS_TO_TICKS(10));
        waited_ms += 10U;
        if (waited_ms >= CONFIG_DAB_RAW_RF_TEST_USB_TIMEOUT_MS)
        {
            ESP_LOGE(TAG, "MM8108 did not enumerate within %u ms",
                     (unsigned)waited_ms);
            return EDGEZ_UMAC_DRIVER_ERROR;
        }
    }

    mmhal_init();
    static const uint8_t mesh_id[] = CONFIG_HALOW_MESH_ID;
    static const uint8_t passphrase[] = CONFIG_HALOW_MESH_PASSPHRASE;
    struct edgez_umac_mesh_runtime_config config = {
        .radio = edgez_rf_driver_ops(),
        .country_code = CONFIG_HALOW_COUNTRY_CODE,
        .channel = {
            .operating_frequency_hz =
                (uint32_t)CONFIG_DAB_RAW_RF_TEST_FREQUENCY_KHZ * 1000U,
            .operating_bw_mhz = CONFIG_DAB_RAW_RF_TEST_BANDWIDTH_MHZ,
            /* Keep the interoperable 1 MHz primary inside wider S1G
             * operating channels, matching the H7608/netifd profile. */
            .primary_bw_mhz = 1U,
            .primary_1mhz_channel_index = 0U,
        },
        .mesh_id_length = sizeof(mesh_id) - 1U,
        .beacon_interval_tu = 100U,
        .compressed_ssid = 0x4544475aU,
        .mcs = CONFIG_DAB_RAW_RF_TEST_MCS,
        .attempts = 2U,
        .rate_control = {
            .enabled = true,
            .initial_mcs = CONFIG_DAB_RAW_RF_TEST_MCS,
            .maximum_mcs = 7U,
            .successes_to_increase = 4U,
        },
        .secure = sizeof(passphrase) > 1U,
        .events = raw_event_ops,
    };
    memcpy(config.mesh_id, mesh_id, sizeof(mesh_id) - 1U);

    const struct edgez_mesh_sae_provider_config security_config = {
        .umac = &runtime->umac,
        .password = passphrase,
        .password_length = sizeof(passphrase) - 1U,
        .mesh_id = mesh_id,
        .mesh_id_length = sizeof(mesh_id) - 1U,
        .mcs = config.mcs,
        .attempts = config.attempts,
        .bandwidth_mhz = config.channel.operating_bw_mhz,
        .short_guard = config.short_guard,
    };

    int status = EDGEZ_UMAC_OK;
    if (config.secure)
    {
        status = edgez_mesh_sae_provider_init(&sae_provider,
                                               &security_config);
        if (status == EDGEZ_UMAC_OK)
        {
            config.security = edgez_mesh_sae_provider_ops();
            config.security_ctx = &sae_provider;
        }
    }

    if (status == EDGEZ_UMAC_OK)
    {
        status = edgez_umac_mesh_runtime_init(runtime, &config);
    }
    if (status == EDGEZ_UMAC_OK)
    {
        status = edgez_rf_bind_umac(&runtime->umac);
    }
    if (status != EDGEZ_UMAC_OK)
    {
        return status;
    }

    status = edgez_umac_mesh_runtime_start(runtime);
    if (status != EDGEZ_UMAC_OK)
    {
        edgez_rf_unbind_umac();
    }
    else
    {
        *info = runtime->radio_info;
        if (config.secure)
        {
            edgez_mesh_sae_provider_set_local_address(
                &sae_provider, runtime->radio_info.mac_addr);
        }
    }
    return status;
}

void app_main(void)
{
    ESP_LOGI(TAG,
             "vendor-neutral UMAC RF test: country=%s frequency=%u kHz "
             "bandwidth=%u MHz",
             CONFIG_HALOW_COUNTRY_CODE,
             (unsigned)CONFIG_DAB_RAW_RF_TEST_FREQUENCY_KHZ,
             (unsigned)CONFIG_DAB_RAW_RF_TEST_BANDWIDTH_MHZ);

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    edgez_mesh_hwmp_init(&hwmp_state);

    struct edgez_umac_radio_info radio = { 0 };
    const int start_status = start_raw_radio(&mesh_runtime, &radio);
    if (start_status != EDGEZ_UMAC_OK)
    {
        ESP_LOGE(TAG, "RF radio startup failed: edgez=%d backend=%d",
                 start_status, mesh_runtime.umac.last_driver_status);
        return;
    }

    ESP_LOGI(TAG,
             "RF ready: backend=%s chip=0x%08" PRIx32
             " vif=%u mac=%02x:%02x:%02x:%02x:%02x:%02x",
             mesh_runtime.umac.driver->name, radio.chip_id,
             mesh_runtime.umac.vif_id,
             radio.mac_addr[0], radio.mac_addr[1], radio.mac_addr[2],
             radio.mac_addr[3], radio.mac_addr[4], radio.mac_addr[5]);

    ESP_LOGI(TAG, "private beacon active: len=%u interval=100 TU",
             (unsigned)mesh_runtime.beacon_length);
    ESP_ERROR_CHECK(edgez_mesh_set_transport(
        &private_mesh_transport, &mesh_runtime));
    ESP_ERROR_CHECK(edgez_mesh_init(
        CONFIG_DAB_RAW_RF_TEST_INTERVAL_MS));
#if CONFIG_DAB_WIFI_EXTENDER
    ESP_ERROR_CHECK(wifi_extender_start(radio.mac_addr, false));
#endif

    while (true)
    {
        if (atomic_exchange_explicit(&pending_peer_discovery, false,
                                     memory_order_acquire))
        {
            const int discover = edgez_umac_mesh_controller_discover(
                &mesh_runtime.controller, pending_peer,
                atomic_load_explicit(&pending_peer_timestamp_ms,
                                     memory_order_relaxed));
            ESP_LOGI(TAG,
                     "deferred protected-frame peer discovery=%d peer="
                     "%02x:%02x:%02x:%02x:%02x:%02x",
                     discover, pending_peer[0], pending_peer[1],
                     pending_peer[2], pending_peer[3], pending_peer[4],
                     pending_peer[5]);
        }
        ESP_LOGI(TAG,
                 "private mesh rx=%" PRIu32 " beacon=%" PRIu32
                 " auth=%" PRIu32 " mpm=%" PRIu32 " data=%" PRIu32
                 " protected=%" PRIu32
                 " decrypted=%" PRIuLEAST32 " decrypt_fail=%" PRIuLEAST32
                 " msdu=%" PRIuLEAST32 " msdu_fail=%" PRIuLEAST32
                 " bat_rx=%" PRIuLEAST32 " bat_tx=%" PRIuLEAST32
                 " bat_tx_fail=%" PRIuLEAST32
                 " qos_null=%" PRIu32
                 " unsupported=%" PRIu32 " malformed=%" PRIu32
                 " peers=%u transitions=%" PRIu32
                 " op_fail=%" PRIu32 " tx_status=%" PRIuLEAST32
                 " tx_fail=%" PRIuLEAST32 " tx_ampdu=%" PRIuLEAST32
                 " restart=%" PRIuLEAST32,
                 mesh_runtime.rx_pipeline.metrics.received,
                 mesh_runtime.rx_pipeline.metrics.beacons,
                 mesh_runtime.rx_pipeline.metrics.authentications,
                 mesh_runtime.rx_pipeline.metrics.peering_actions,
                 mesh_runtime.rx_pipeline.metrics.data,
                 mesh_runtime.rx_pipeline.metrics.protected_data,
                 atomic_load(&counters.decrypted_rx),
                 atomic_load(&counters.decrypt_failed),
                 atomic_load(&counters.msdu_decoded),
                 atomic_load(&counters.msdu_failed),
                 atomic_load(&counters.batman_received),
                 atomic_load(&counters.batman_transmitted),
                 atomic_load(&counters.batman_tx_failed),
                 mesh_runtime.rx_pipeline.metrics.qos_null,
                 mesh_runtime.rx_pipeline.metrics.unsupported,
                 mesh_runtime.rx_pipeline.metrics.malformed,
                 (unsigned)edgez_umac_peer_count(&mesh_runtime.umac),
                 mesh_runtime.peering_manager.transitions,
                 mesh_runtime.peering_manager.operation_failures,
                 atomic_load(&counters.tx_status),
                 atomic_load(&counters.tx_status_failed),
                 atomic_load(&counters.tx_status_aggregated),
                 atomic_load(&counters.restart));
        edgez_umac_mesh_runtime_tick(
            &mesh_runtime, (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS));
        vTaskDelay(pdMS_TO_TICKS(CONFIG_DAB_RAW_RF_TEST_INTERVAL_MS));
    }
}
