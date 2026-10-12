#include "sdkconfig.h"
#include "edgez_mesh_iperf.h"
#if CONFIG_DAB_MESH_IPERF
#include "esp_log.h"
#include "lwip/tcp.h"
#include "lwip/sys.h"

/* Receive-only iperf2 -C endpoint: classic unidirectional TCP requires no
 * application handshake/reply. Byte totals include the client's test header.
 * No UDP, iperf3, reverse mode or parallel connections are supported. */
static const char *TAG = "mesh_iperf";
static struct tcp_pcb *listener, *client;
static bool listener_ready;
static ip_addr_t bound_mesh_ip, bound_wifi_ip;
static bool bound_all_interfaces;
static uint32_t bound_generation, started_ms, last_rx_ms, last_try_ms;
static uint64_t received;

static void report(const char *reason)
{
    uint32_t duration = sys_now() - started_ms;
    ESP_LOGW(TAG, "IPERF RX end=%s bytes=%llu duration_ms=%lu kbps=%lu",
             reason, (unsigned long long)received, (unsigned long)duration,
             (unsigned long)(duration ? received * 8 / duration : 0));
}

static void abort_client(const char *reason)
{
    if (!client) return;
    struct tcp_pcb *pcb = client;
    client = NULL;
    tcp_arg(pcb, NULL);
    tcp_err(pcb, NULL);
    report(reason);
    tcp_abort(pcb);
}

static void receive_error(void *arg, err_t err)
{
    (void)arg; (void)err;
    client = NULL; /* lwIP has already freed the PCB. */
    report("connection_error");
}

static err_t receive_data(void *arg, struct tcp_pcb *pcb, struct pbuf *p, err_t err)
{
    (void)arg;
    if (err != ERR_OK) {
        if (p) pbuf_free(p);
        abort_client("receive_error");
        return ERR_ABRT;
    }
    if (!p) {
        report("complete");
        client = NULL;
        tcp_recv(pcb, NULL);
        tcp_err(pcb, NULL);
        if (tcp_close(pcb) != ERR_OK) {
            tcp_abort(pcb);
            return ERR_ABRT;
        }
        return ERR_OK;
    }
    received += p->tot_len;
    last_rx_ms = sys_now();
    tcp_recved(pcb, p->tot_len);
    pbuf_free(p);
    return ERR_OK;
}

static err_t accept_client(void *arg, struct tcp_pcb *pcb, err_t err)
{
    (void)arg;
    if (err != ERR_OK || client) {
        tcp_abort(pcb);
        return ERR_ABRT;
    }
    client = pcb;
    received = 0;
    started_ms = last_rx_ms = sys_now();
    tcp_recv(pcb, receive_data);
    tcp_err(pcb, receive_error);
    ESP_LOGW(TAG, "IPERF RX started peer=%s", ipaddr_ntoa(&pcb->remote_ip));
    return ERR_OK;
}

void edgez_mesh_iperf_update(struct netif *mesh, struct netif *wifi_upstream,
                            bool ready, uint32_t generation)
{
    LWIP_ASSERT_CORE_LOCKED();
    const ip_addr_t *mesh_ip = netif_ip_addr4(mesh);
    const ip_addr_t *wifi_ip = wifi_upstream ? netif_ip_addr4(wifi_upstream) : NULL;
    ready = ready && netif_is_up(mesh) && netif_is_link_up(mesh) &&
            !ip_addr_isany(mesh_ip);
    bool serve_wifi = ready && wifi_upstream && netif_is_up(wifi_upstream) &&
                      netif_is_link_up(wifi_upstream) && !ip_addr_isany(wifi_ip);
    if (listener && (!ready || generation != bound_generation ||
                     !ip_addr_cmp(mesh_ip, &bound_mesh_ip) ||
                     serve_wifi != bound_all_interfaces ||
                     (serve_wifi && !ip_addr_cmp(wifi_ip, &bound_wifi_ip)))) {
        abort_client("mesh_changed");
        tcp_accept(listener, NULL);
        tcp_close(listener); /* Listening PCB close cannot fail. */
        listener = NULL;
        __atomic_store_n(&listener_ready, false, __ATOMIC_RELEASE);
        ESP_LOGI(TAG, "IPERF RX listener stopped");
    }
    if (client && (uint32_t)(sys_now() - last_rx_ms) >= 30000) abort_client("idle_timeout");
    if (!ready || listener) return;
    uint32_t now = sys_now();
    if (last_try_ms && (uint32_t)(now - last_try_ms) < 10000) return;
    last_try_ms = now;
    struct tcp_pcb *pcb = tcp_new_ip_type(IPADDR_TYPE_V4);
    if (!pcb) return;
    if (!serve_wifi) tcp_bind_netif(pcb, mesh);
    err_t err = tcp_bind(pcb, serve_wifi ? IP4_ADDR_ANY : mesh_ip, 5001);
    if (err != ERR_OK) {
        tcp_close(pcb);
        ESP_LOGW(TAG, "IPERF RX bind failed err=%d", err);
        return;
    }
    listener = tcp_listen_with_backlog_and_err(pcb, 1, &err);
    if (!listener) {
        tcp_close(pcb);
        ESP_LOGW(TAG, "IPERF RX listen failed err=%d", err);
        return;
    }
    bound_mesh_ip = *mesh_ip;
    if (serve_wifi) bound_wifi_ip = *wifi_ip;
    else ip_addr_set_zero(&bound_wifi_ip);
    bound_all_interfaces = serve_wifi;
    bound_generation = generation;
    tcp_accept(listener, accept_client);
    __atomic_store_n(&listener_ready, true, __ATOMIC_RELEASE);
    ESP_LOGW(TAG, "IPERF RX ready on HaLow: iperf -c %s -p 5001 -C -t 60 -i 1",
             ipaddr_ntoa(mesh_ip));
    if (serve_wifi) {
        ESP_LOGW(TAG, "IPERF RX ready on Wi-Fi upstream: iperf -c %s -p 5001 -C -t 60 -i 1",
                 ipaddr_ntoa(wifi_ip));
    }
}

bool edgez_mesh_iperf_ready(void)
{
    return __atomic_load_n(&listener_ready, __ATOMIC_ACQUIRE);
}
#else
void edgez_mesh_iperf_update(struct netif *mesh, struct netif *wifi_upstream,
                            bool ready, uint32_t generation)
{
    (void)mesh; (void)wifi_upstream; (void)ready; (void)generation;
}
bool edgez_mesh_iperf_ready(void) { return false; }
#endif
