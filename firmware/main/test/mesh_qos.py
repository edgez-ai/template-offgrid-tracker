#!/usr/bin/env python3
"""Exercise actual application/mesh TX functions with a fake radio."""
from pathlib import Path
import re
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
app = (root / 'main/edgez_mesh_internet.c').read_text()
mesh = (root / 'third_party/esp-halow/halow/components/mm-iot-edgez/ports/'
               'esp_idf/src/edgez_mesh.c').read_text()

def function(source, name):
    match = re.search(r'(?:static )?esp_err_t ' + name + r'\(', source)
    start = source.index('{', match.start())
    depth = 1
    end = start + 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[match.start():end]

stub = r'''
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include <stdatomic.h>
typedef int esp_err_t;
enum { ESP_OK, ESP_ERR_INVALID_ARG, ESP_ERR_INVALID_STATE, ESP_ERR_NO_MEM,
       ESP_ERR_NOT_FOUND, ESP_ERR_INVALID_SIZE };
#define EDGEZ_BATADV_MAX_PACKET_LEN 1536
#define EDGEZ_ETH_HEADER_LEN 14
#define EDGEZ_BATADV_ETHERTYPE 0x4305
#define EDGEZ_RF_PEER_LIMIT 2
#define MALLOC_CAP_8BIT 0
#define portMAX_DELAY 0
#define ESP_LOGD(...) ((void)0)
#define memory_checkpoint(...) ((void)0)
static int state, lock, *state_lock = &lock;
static uint8_t local_mac[6];
static atomic_uint tx_ok, tx_failed;
static unsigned calls, observed_tid, observed_timeout;
typedef struct {
    esp_err_t (*transmit_ethernet)(void *ctx, const uint8_t *frame,
                                  size_t frame_len, const uint8_t receiver[6],
                                  uint8_t tid, uint32_t timeout_ms);
} edgez_mesh_transport_ops_t;
static const edgez_mesh_transport_ops_t *transport_ops;
static void *transport_ctx;
static void *heap_caps_malloc(size_t n, int caps) { (void)caps; return malloc(n); }
#define heap_caps_free free
static void xSemaphoreTake(void *p,int n) {(void)p;(void)n;}
static void xSemaphoreGive(void *p) {(void)p;}
static uint32_t now_ms(void) {return 100;}
static void mmhalow_mesh_discovery_note_traffic(void) {}
static void note_traffic(void) { mmhalow_mesh_discovery_note_traffic(); }
static bool peer_authorized(const uint8_t *p) {(void)p;return true;}
static uint8_t snapshot_authorized_peers(uint8_t peers[][6]) {memset(peers,1,6);return 1;}
static bool mac_equal(const uint8_t *a,const uint8_t *b) {return !memcmp(a,b,6);}
static esp_err_t mmhalow_transmit_raw(const void *p,size_t n,const uint8_t *ra,
                                    uint8_t tid,uint32_t timeout) {
    assert(p && ra && n > 14); calls++; observed_tid=tid; observed_timeout=timeout;
    return ESP_OK;
}
static bool edgez_batadv_lite_build_unicast(void *s,const uint8_t *d,const uint8_t *f,
        size_t n,uint32_t t,uint8_t *out,size_t *len,uint8_t *hop) {
    (void)s;(void)t;memcpy(hop,d,6);memcpy(out,f,n);*len=n;return true;
}
static bool edgez_batadv_lite_build_broadcast(void *s,const uint8_t *f,size_t n,
                                             uint8_t *out,size_t *len) {
    (void)s;memcpy(out,f,n);*len=n;return true;
}
typedef struct {uint32_t generation;bool broadcast;uint8_t data[60],gateway[6];size_t len;} packet_t;
static uint32_t generation=1;
static bool accepting_packets=true;
'''
names = ['send_packet_to_peer', 'fanout', 'edgez_mesh_send_unicast_qos',
         'edgez_mesh_send_broadcast_qos', 'edgez_mesh_send_unicast',
         'edgez_mesh_send_broadcast']
code = stub + '\n'.join(function(mesh, n) for n in names)
code += '\n' + '\n'.join(re.findall(r'^#define TX_(?:PRIORITY_TID|PRIORITY_READY_TIMEOUT_MS|BULK_READY_TIMEOUT_MS) .*$', app, re.M))
code += '\n' + function(app, 'submit_tx_packet')
code += r'''
int main(void) {
    packet_t p={.generation=1,.len=60};
    for (int broadcast=0;broadcast<2;broadcast++) {
        p.broadcast=broadcast;
        assert(submit_tx_packet(&p,true)==ESP_OK);
        assert(observed_tid==6 && observed_timeout==20);
        assert(submit_tx_packet(&p,false)==ESP_OK);
        assert(observed_tid==0 && observed_timeout==0);
    }
    assert(edgez_mesh_send_unicast(p.gateway,p.data,p.len)==ESP_OK);
    assert(observed_tid==0 && observed_timeout==50);
    assert(edgez_mesh_send_broadcast(p.data,p.len)==ESP_OK);
    assert(observed_tid==0 && observed_timeout==50);
    unsigned before=calls;
    assert(edgez_mesh_send_unicast_qos(p.gateway,p.data,p.len,8,0)==ESP_ERR_INVALID_ARG);
    assert(edgez_mesh_send_broadcast_qos(p.data,p.len,8,0)==ESP_ERR_INVALID_ARG);
    p.generation=2;
    assert(submit_tx_packet(&p,true)==ESP_ERR_INVALID_STATE);
    p.generation=1;accepting_packets=false;
    assert(submit_tx_packet(&p,true)==ESP_ERR_INVALID_STATE);
    assert(calls==before);
}
'''
with tempfile.TemporaryDirectory() as temp:
    source = Path(temp, 'test.c')
    source.write_text(code)
    binary = str(Path(temp, 'test'))
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror',
                    '-fsanitize=address,undefined', str(source), '-o', binary], check=True)
    subprocess.run([binary], check=True)
print('Mesh QoS: priority/bulk unicast+broadcast, legacy defaults, invalid TID and stale state passed')
