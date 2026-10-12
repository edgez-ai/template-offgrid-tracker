/* Ported from edge-device-esp32-internal wifi-extender (3016950). */
/* Bounded UDP DNS relay for downstream clients that use the gateway as DNS. */
#include "extender_dns.h"
#include "lwip/udp.h"
#include "lwip/sys.h"
#include "esp_random.h"
#include <string.h>
#define DNS_SLOTS 16
static struct udp_pcb *server, *forwarder;
static struct netif *downstream;
static ip_addr_t resolver_ip;
static bool active;
static struct {
    bool used;
    ip_addr_t client;
    uint16_t port, original_id, forwarded_id;
    uint32_t started;
} slots[DNS_SLOTS];
static uint16_t read16(const uint8_t *p) { return (p[0]<<8)|p[1]; }
static void put16(uint8_t *p,uint16_t v) { p[0]=v>>8;p[1]=v; }
static void response(void *arg,struct udp_pcb *pcb,struct pbuf *p,const ip_addr_t *addr,u16_t port)
{
    (void)arg;(void)pcb;
    uint8_t h[12];
    if (!p) return;
    if (!active || port!=53 || !ip_addr_cmp(addr,&resolver_ip) || p->tot_len<12 || p->tot_len>4096) goto done;
    pbuf_copy_partial(p,h,12,0);
    if (!(h[2]&0x80)) goto done;
    for (unsigned i=0;i<DNS_SLOTS;++i) {
        if (!slots[i].used || slots[i].forwarded_id!=read16(h) || (uint32_t)(sys_now()-slots[i].started)>5000) continue;
        struct pbuf *copy=pbuf_alloc(PBUF_TRANSPORT,p->tot_len,PBUF_RAM);
        if (copy) {
            pbuf_copy(copy,p);put16(copy->payload,slots[i].original_id);
            udp_sendto(server,copy,&slots[i].client,slots[i].port);pbuf_free(copy);
        }
        slots[i].used=false;break;
    }
done: pbuf_free(p);
}
static void request(void *arg,struct udp_pcb *pcb,struct pbuf *p,const ip_addr_t *addr,u16_t port)
{
    (void)arg;(void)pcb; uint8_t h[12];
    if (!p) return;
    if (!active || !IP_IS_V4(addr) || p->tot_len<12 || p->tot_len>1232 ||
        !ip4_addr_net_eq(ip_2_ip4(addr),netif_ip4_addr(downstream),netif_ip4_netmask(downstream))) goto done;
    pbuf_copy_partial(p,h,12,0);
    if ((h[2]&0x80) || read16(h+4)!=1) goto done;
    for (unsigned i=0;i<DNS_SLOTS;++i) {
        if (slots[i].used && (uint32_t)(sys_now()-slots[i].started)<5000) continue;
        struct pbuf *copy=pbuf_alloc(PBUF_TRANSPORT,p->tot_len,PBUF_RAM);
        if (!copy) break;
        uint16_t id;bool collision;
        do {
            id=(uint16_t)esp_random();collision=false;
            for(unsigned j=0;j<DNS_SLOTS;++j) if(slots[j].used && slots[j].forwarded_id==id) collision=true;
        } while(collision);
        slots[i].used=true;slots[i].client=*addr;slots[i].port=port;
        slots[i].original_id=read16(h);slots[i].forwarded_id=id;slots[i].started=sys_now();
        pbuf_copy(copy,p);put16(copy->payload,id);
        if(udp_sendto(forwarder,copy,&resolver_ip,53)!=ERR_OK) slots[i].used=false;
        pbuf_free(copy);break;
    }
done: pbuf_free(p);
}
bool extender_dns_update(struct netif *mesh,struct netif *upstream,const ip_addr_t *resolver,bool enabled)
{
    if (!enabled || !resolver || !IP_IS_V4(resolver) || ip_addr_isany(resolver)) {
        active=false;memset(slots,0,sizeof(slots));return false;
    }
    if(!server) {
        server=udp_new_ip_type(IPADDR_TYPE_V4);
        if(!server) return false;
        udp_bind_netif(server,mesh);
        if(udp_bind(server,IP_ANY_TYPE,53)!=ERR_OK) { udp_remove(server);server=NULL;return false; }
        udp_recv(server,request,NULL);
    }
    if(!forwarder) {
        forwarder=udp_new_ip_type(IPADDR_TYPE_V4);
        if(!forwarder) return false;
        udp_bind_netif(forwarder,upstream);
        if(udp_bind(forwarder,IP_ANY_TYPE,0)!=ERR_OK) { udp_remove(forwarder);forwarder=NULL;return false; }
        udp_recv(forwarder,response,NULL);
    }
    if(!ip_addr_cmp(&resolver_ip,resolver)) memset(slots,0,sizeof(slots));
    resolver_ip=*resolver;downstream=mesh;active=true;return true;
}
