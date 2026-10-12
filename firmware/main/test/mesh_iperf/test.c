#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <assert.h>
#include <stdlib.h>
#define CONFIG_DAB_MESH_IPERF 1
#define ESP_LOGW(...) ((void)0)
#define ESP_LOGI(...) ((void)0)
#define LWIP_ASSERT_CORE_LOCKED() ((void)0)
#define ERR_OK 0
#define ERR_ABRT -13
#define IPADDR_TYPE_V4 0
typedef int err_t;
typedef uint32_t ip_addr_t;
static const ip_addr_t any_ip;
#define IP4_ADDR_ANY (&any_ip)
struct pbuf { unsigned tot_len; };
struct netif { ip_addr_t ip; bool up,link; };
struct tcp_pcb { ip_addr_t remote_ip; struct netif *netif; };
static unsigned clock_ms, freed, acknowledged, aborted, closed;
static bool alloc_fail,listen_fail,close_fail;
static uint32_t sys_now(void){return clock_ms;}
static const ip_addr_t *netif_ip_addr4(struct netif*n){return &n->ip;}
static bool netif_is_up(struct netif*n){return n->up;}
static bool netif_is_link_up(struct netif*n){return n->link;}
static bool ip_addr_isany(const ip_addr_t*p){return !*p;}
static bool ip_addr_cmp(const ip_addr_t*a,const ip_addr_t*b){return *a==*b;}
static void ip_addr_set_zero(ip_addr_t*a){*a=0;}
static void tcp_arg(struct tcp_pcb*p,void*a){(void)p;(void)a;}
static void tcp_err(struct tcp_pcb*p,void(*f)(void*,err_t)){(void)p;(void)f;}
static void tcp_recv(struct tcp_pcb*p,err_t(*f)(void*,struct tcp_pcb*,struct pbuf*,err_t)){(void)p;(void)f;}
static void tcp_accept(struct tcp_pcb*p,err_t(*f)(void*,struct tcp_pcb*,err_t)){(void)p;(void)f;}
static void tcp_abort(struct tcp_pcb*p){++aborted;free(p);}
static err_t tcp_close(struct tcp_pcb*p){if(close_fail)return -1;++closed;free(p);return 0;}
static struct tcp_pcb *tcp_new_ip_type(int t){(void)t;return alloc_fail?NULL:calloc(1,sizeof(struct tcp_pcb));}
static void tcp_bind_netif(struct tcp_pcb*p,struct netif*n){p->netif=n;}
static err_t tcp_bind(struct tcp_pcb*p,const ip_addr_t*ip,int port){assert(port==5001);assert((p->netif&&*ip==p->netif->ip)||(!p->netif&&!*ip));return 0;}
static struct tcp_pcb *tcp_listen_with_backlog_and_err(struct tcp_pcb*p,int n,err_t*err){assert(n==1);*err=listen_fail?-1:0;return listen_fail?NULL:p;}
static void pbuf_free(struct pbuf*p){++freed;free(p);}
static void tcp_recved(struct tcp_pcb*p,unsigned n){(void)p;acknowledged+=n;}
#include "server.inc"
int main(void){
struct netif mesh={123,true,true},wifi={789,true,true};clock_ms=10000;
edgez_mesh_iperf_update(&mesh,NULL,false,1);assert(!listener);
edgez_mesh_iperf_update(&mesh,NULL,true,1);assert(listener&&listener->netif==&mesh&&!bound_all_interfaces);
struct tcp_pcb*p=tcp_new_ip_type(0);assert(accept_client(NULL,p,0)==0);
assert(accept_client(NULL,tcp_new_ip_type(0),0)==ERR_ABRT&&client==p);
struct pbuf*b=malloc(sizeof(*b));b->tot_len=1400;assert(receive_data(NULL,p,b,0)==0&&received==1400&&freed==1&&acknowledged==1400);
assert(receive_data(NULL,p,NULL,0)==0&&!client&&listener);
p=tcp_new_ip_type(0);accept_client(NULL,p,0);clock_ms+=30000;
edgez_mesh_iperf_update(&mesh,NULL,true,1);assert(!client&&listener);
clock_ms+=10000;edgez_mesh_iperf_update(&mesh,&wifi,true,1);
assert(listener&&!listener->netif&&bound_all_interfaces&&bound_wifi_ip==789);
p=tcp_new_ip_type(0);accept_client(NULL,p,0);mesh.ip=456;clock_ms+=10000;
edgez_mesh_iperf_update(&mesh,&wifi,true,2);assert(!client&&listener&&bound_mesh_ip==456);
wifi.ip=790;clock_ms+=10000;edgez_mesh_iperf_update(&mesh,&wifi,true,2);
assert(listener&&bound_wifi_ip==790);
p=tcp_new_ip_type(0);accept_client(NULL,p,0);free(p);receive_error(NULL,-1);assert(!client);
p=tcp_new_ip_type(0);accept_client(NULL,p,0);close_fail=true;
assert(receive_data(NULL,p,NULL,0)==ERR_ABRT&&!client);close_fail=false;
edgez_mesh_iperf_update(&mesh,&wifi,false,2);assert(!listener&&!client);
clock_ms+=10000;listen_fail=true;edgez_mesh_iperf_update(&mesh,&wifi,true,2);assert(!listener);
clock_ms+=10000;alloc_fail=true;edgez_mesh_iperf_update(&mesh,&wifi,true,2);assert(!listener);
printf("HaLow/Wi-Fi iperf lifecycle: binding, one client, receive/free, FIN, idle, address change, reset and allocation failures passed\n");
}
