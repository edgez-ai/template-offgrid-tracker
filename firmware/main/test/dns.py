#!/usr/bin/env python3
"""Run the actual bounded DNS relay against in-memory lwIP transport stubs."""
from pathlib import Path
import subprocess,tempfile
root=Path(__file__).resolve().parents[2]
s=(root/'main/extender_dns.c').read_text()
s='\n'.join(line for line in s.splitlines() if not line.startswith('#include'))
pre=r'''
#include <stdint.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include <stdio.h>
typedef uint16_t u16_t;
typedef struct {uint32_t addr;} ip_addr_t;
struct netif {ip_addr_t ip,mask;};
struct udp_pcb {struct netif *netif;};
struct pbuf {uint16_t tot_len;void *payload;};
#define IP_IS_V4(a) true
#define ip_2_ip4(a) (a)
#define netif_ip4_addr(n) (&(n)->ip)
#define netif_ip4_netmask(n) (&(n)->mask)
#define ip4_addr_net_eq(a,b,m) (((a)->addr&(m)->addr)==((b)->addr&(m)->addr))
#define ip_addr_cmp(a,b) ((a)->addr==(b)->addr)
#define ip_addr_isany(a) (!(a)->addr)
#define PBUF_TRANSPORT 0
#define PBUF_RAM 0
#define IPADDR_TYPE_V4 0
#define IP_ANY_TYPE NULL
#define ERR_OK 0
static uint32_t clock_ms;
static uint32_t sys_now(void){return clock_ms;}
static uint32_t esp_random(void){static uint32_t v=0x1234;return ++v;}
static int sends,allocations;
static uint8_t sent[4096];static uint16_t sent_len,sent_port;
static struct udp_pcb *sent_pcb;static ip_addr_t sent_ip;
static struct pbuf *pbuf_alloc(int a,unsigned n,int b){(void)a;(void)b;struct pbuf *p=malloc(sizeof(*p));p->payload=calloc(1,n);p->tot_len=n;++allocations;return p;}
static void pbuf_free(struct pbuf *p){free(p->payload);free(p);--allocations;}
static void pbuf_copy_partial(struct pbuf *p,void *out,unsigned n,unsigned off){memcpy(out,(uint8_t*)p->payload+off,n);}
static void pbuf_copy(struct pbuf *to,struct pbuf *from){memcpy(to->payload,from->payload,from->tot_len);}
static struct udp_pcb *udp_new_ip_type(int t){(void)t;return calloc(1,sizeof(struct udp_pcb));}
static void udp_remove(struct udp_pcb *p){free(p);}
static void udp_bind_netif(struct udp_pcb *p,struct netif *n){p->netif=n;}
static int udp_bind(struct udp_pcb *p,void *a,int port){(void)p;(void)a;(void)port;return 0;}
static void udp_recv(struct udp_pcb *p,void (*cb)(void*,struct udp_pcb*,struct pbuf*,const ip_addr_t*,u16_t),void *arg){(void)p;(void)cb;(void)arg;}
static int udp_sendto(struct udp_pcb *pcb,struct pbuf *p,const ip_addr_t *ip,u16_t port){++sends;sent_pcb=pcb;sent_ip=*ip;sent_port=port;sent_len=p->tot_len;memcpy(sent,p->payload,p->tot_len);return 0;}
'''
test=r'''
static struct pbuf *query(uint16_t id) {struct pbuf *p=pbuf_alloc(0,12,0);put16(p->payload,id);put16((uint8_t*)p->payload+4,1);return p;}
int main(void){
 struct netif mesh={.ip={0x0a2a0001},.mask={0xffffff00}},up={0};
 ip_addr_t dns={0x08080808},client_ip={0x0a2a0002},spoof={0x09090909};
 assert(extender_dns_update(&mesh,&up,&dns,true));
 request(NULL,server,query(0xabcd),&client_ip,12000);
 assert(sends==1 && sent_pcb==forwarder && sent_pcb->netif==&up && sent_ip.addr==dns.addr && sent_port==53);
 uint16_t id=read16(sent);assert(id!=0xabcd);
 struct pbuf *p=query(id);((uint8_t*)p->payload)[2]=0x80;response(NULL,forwarder,p,&spoof,53);assert(sends==1);
 p=query(id);((uint8_t*)p->payload)[2]=0x80;response(NULL,forwarder,p,&dns,53);
 assert(sends==2 && sent_pcb==server && sent_pcb->netif==&mesh && sent_port==12000 && read16(sent)==0xabcd);
 request(NULL,server,query(1),&spoof,100);assert(sends==2);
 for(unsigned i=0;i<DNS_SLOTS;++i)request(NULL,server,query(i),&client_ip,12000+i);
 assert(sends==2+DNS_SLOTS);
 request(NULL,server,query(99),&client_ip,13000);assert(sends==2+DNS_SLOTS);
 clock_ms=5001;request(NULL,server,query(100),&client_ip,13000);assert(sends==3+DNS_SLOTS);
 assert(!extender_dns_update(&mesh,&up,NULL,false));
 request(NULL,server,query(1),&client_ip,12000);assert(sends==3+DNS_SLOTS);
 assert(!allocations);udp_remove(server);udp_remove(forwarder);
 puts("DNS relay: request/response ID mapping, separate interfaces, source filtering, bounded capacity, expiry, shutdown, and pbuf ownership passed");
}'''
with tempfile.TemporaryDirectory() as t:
 p=Path(t);(p/'test.c').write_text(pre+s+test)
 subprocess.run(['cc','-fsanitize=address,undefined',str(p/'test.c'),'-o',str(p/'test')],check=True)
 subprocess.run([str(p/'test')],check=True)
