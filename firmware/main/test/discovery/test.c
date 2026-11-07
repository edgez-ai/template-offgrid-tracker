#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#include <string.h>
#include "edgez_pawr_protocol.h"
#define ESP_OK 0
#define portMUX_INITIALIZER_UNLOCKED 0
typedef int portMUX_TYPE;
#define taskENTER_CRITICAL(lock) ((void)(lock))
#define taskEXIT_CRITICAL(lock) ((void)(lock))
static void log_message(const char *tag,const char *fmt,...) {(void)tag;(void)fmt;}
#define ESP_LOGI(...) log_message(__VA_ARGS__)
static int64_t now = 2000000;
static int64_t esp_timer_get_time(void) {return now;}
static bool online;
static unsigned publishes, sends;
static uint8_t published[2048], sent[2048], sent_to[6];
static size_t published_length, sent_length;
static char topic_name[64];
static bool wifi_mqtt_ready(void *arg) {(void)arg;return online;}
static int wifi_mqtt_publish(const char *topic,const void *data,size_t length,int qos,bool retain,void *arg)
{
    (void)arg; assert(qos==1 && !retain);
    if (!online) return -1;
    assert(length<=sizeof(published)); strcpy(topic_name,topic);
    memcpy(published,data,length);published_length=length;
    return ++publishes;
}
static int edgez_halow_mesh_transmit_pawr_control(const uint8_t to[6],const uint8_t *data,size_t length)
{assert(length<=sizeof(sent));memcpy(sent,data,length);sent_length=length;memcpy(sent_to,to,6);++sends;return ESP_OK;}
#include "discovery.inc"
int main(void)
{
    uint8_t packet[] = {0x8, 0x2, 0x18, 0x1, 0x20, 0x5, 0xc2, 0x6, 0x2c, 0x8, 0x3, 0x2a, 0x3, 0x64, 0x65, 0x76, 0x52, 0x20, 0x0, 0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7, 0x8, 0x9, 0xa, 0xb, 0xc, 0xd, 0xe, 0xf, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0xc0, 0x1, 0x5};
    uint8_t source[6] = {0,0,0,0,0,2};
    const uint8_t acceptance[] = {16,2,0xa2,6,1,0x42};
    halow_discovery_tick();assert(sends==0);
    online=true;halow_discovery_tick();assert(sends==1);
    uint32_t hash,ssid;
    assert(edgez_pawr_decode_response(sent,sent_length,&hash,&ssid));
    assert(hash==0 && ssid==discovery_ssid());
    assert(!halow_discovery_accept(acceptance,sizeof(acceptance)));
    assert(halow_discovery_receive(source,packet,sizeof(packet)));
    assert(!strcmp(topic_name,"system/discover") && published_length==sizeof(packet));
    assert(!memcmp(published,packet,sizeof(packet)));
    assert(halow_discovery_accept(acceptance,sizeof(acceptance)));
    assert(halow_discovery_receive(source,packet,sizeof(packet)));
    struct edgez_pawr_request_view request;
    assert(edgez_pawr_decode_request(sent,sent_length,&request));
    assert(request.type==EDGEZ_PAWR_REQUEST_MESH_PACKET && request.compressed_ssid==discovery_ssid());
    assert(request.payload_length==sizeof(acceptance));
    assert(!memcmp(request.payload,acceptance,sizeof(acceptance)) && !memcmp(source,sent_to,6));
    const uint8_t beacon[]={8,1,16,2};
    assert(!halow_discovery_receive(source,beacon,sizeof(beacon)));
    assert(!strcmp(topic_name,"system/accepted") && published_length==6 && !memcmp(published,source,6));
    unsigned count=publishes;
    halow_discovery_receive(source,beacon,sizeof(beacon));assert(publishes==count);
    uint8_t unknown[]={16,4};assert(!halow_discovery_accept(unknown,sizeof(unknown)));
    now+=((int64_t)CACHE_TTL_MS+1)*1000;
    assert(!halow_discovery_accept(acceptance,sizeof(acceptance)));
    puts("HC33 discovery advertisement, cloud routing, acceptance replay, and confirmation passed");
    return 0;
}
