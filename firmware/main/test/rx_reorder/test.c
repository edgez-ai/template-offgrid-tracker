#include <assert.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdlib.h>
#include <stdio.h>
#define MMWLAN_MAX_QOS_TID 7
#define MMDRV_SEQ_NUM_BASELINE 8
#define RX_REORDER_TIMEOUT_MS 100
#define RX_REORDER_TIMER_PERIOD_MS 10
#define MMLOG_WRN(...) ((void)0)
#define MMLOG_DBG(...) ((void)0)
#define MMLOG_VRB(...) ((void)0)
#define MMOSAL_ASSERT assert
#define DOT11_FC_SUBTYPE_NULL_DATA 4
#define DOT11_FC_SUBTYPE_QOS_NULL 12
#define DOT11_FC_SUBTYPE_QOS_DATA 8
#define le16toh(x) (x)
struct dot11_hdr { uint16_t frame_control, sequence_control; };
struct dot11_data_hdr { struct dot11_hdr base; };
struct dot11_qos_ctrl { uint16_t field; };
struct mmpkt { struct dot11_data_hdr hdr; struct dot11_qos_ctrl qos; struct mmpkt *next; uint32_t read_timestamp_ms; };
#define mmpktview mmpkt
struct mmpkt_list { struct mmpkt *head; };
struct umac_datapath_sta_data {
int defrag_data;
#include "fields.inc"
};
struct umac_sta_data { struct umac_datapath_sta_data data; int expected[8]; unsigned win[8]; };
struct umac_data { int unused; };
static unsigned now, live, delivered[8], last[8], timeout_count, dup_count, late_count, overflow_count, timers;
static bool timer_ok=true;
static struct umac_datapath_sta_data *umac_sta_data_get_datapath(struct umac_sta_data *s) { return &s->data; }
static struct mmpkt *mmpkt_open(struct mmpkt *p) { return p; }
static void mmpkt_close(struct mmpkt **p) { *p=NULL; }
static void *mmpkt_get_data_start(struct mmpkt *p) { return p; }
static void mmpkt_release(struct mmpkt *p) { assert(live); --live; free(p); }
struct metadata { struct mmpkt *rx; };
static struct metadata mmpkt_get_metadata(struct mmpkt *p) { return (struct metadata){p}; }
static bool mmosal_time_has_passed(unsigned time) { return now>=time; }
static bool mmpkt_list_is_empty(struct mmpkt_list *l) { return !l->head; }
static struct mmpkt *mmpkt_list_peek(struct mmpkt_list *l) { return l->head; }
static unsigned mmpkt_list_length(struct mmpkt_list *l) { unsigned n=0; for(struct mmpkt*p=l->head;p;p=p->next)++n;return n; }
static struct mmpkt *mmpkt_list_dequeue(struct mmpkt_list *l) { struct mmpkt*p=l->head; if(p)l->head=p->next;return p; }
static void mmpkt_list_remove(struct mmpkt_list *l,struct mmpkt *p) { assert(l->head==p);mmpkt_list_dequeue(l); }
static void mmpkt_list_prepend(struct mmpkt_list *l,struct mmpkt *p) { p->next=l->head;l->head=p; }
static void mmpkt_list_append(struct mmpkt_list *l,struct mmpkt *p) { struct mmpkt **q=&l->head;while(*q)q=&(*q)->next;*q=p;p->next=NULL; }
static void mmpkt_list_insert_after(struct mmpkt_list*l,struct mmpkt*w,struct mmpkt*p) { (void)l;p->next=w->next;w->next=p; }
#define MMPKT_LIST_WALK(l,w,n) for((w)=(l)->head;(w)&&((n)=(w)->next,1);(w)=(n))
static int umac_ba_get_expected_rx_seq_num(struct umac_sta_data*s,unsigned tid) { assert(tid<8);return s->expected[tid]; }
static unsigned umac_ba_get_reorder_buffer_size(struct umac_sta_data*s,unsigned tid) { return tid<8?s->win[tid]:0; }
static bool dot11_sequence_control_lt(uint16_t a,uint16_t b) { return (int16_t)(a-b)<0; }
static unsigned dot11_frame_control_get_subtype(unsigned x) { return x; }
static unsigned dot11_data_hdr_get_len(const struct dot11_data_hdr*p) { return sizeof(*p); }
static unsigned dot11_qos_control_get_tid(unsigned x) { return x; }
static const void *dot11_get_ra(const struct dot11_hdr*p) { return p; }
static bool mm_mac_addr_is_multicast(const void*p) { (void)p;return false; }
static void umac_datapath_process_rx_data_frame_after_reorder(struct umac_sta_data*s,struct umac_datapath_sta_data*d,struct mmpkt*p,struct mmpkt*v) {
(void)d;(void)v;unsigned t=p->qos.field;last[t]=p->hdr.base.sequence_control; ++delivered[t];s->expected[t]=(last[t]+16)&65535;mmpkt_release(p);
}
static bool umac_core_register_timeout(struct umac_data*u,unsigned ms,void(*f)(void*,void*),void*a,void*b) { (void)u;(void)ms;(void)f;(void)a;(void)b;if(timer_ok)++timers;return timer_ok; }
#define STAT(name,counter) static void umac_stats_increment_datapath_rx_reorder_##name(struct umac_data*u) { (void)u;++counter; }
STAT(timedout,timeout_count)
STAT(retransmit_drops,dup_count)
STAT(outdated_drops,late_count)
STAT(overflow,overflow_count)
static void umac_stats_increment_datapath_rx_reorder_total(struct umac_data*u) { (void)u; }
static void umac_stats_update_datapath_rx_reorder_list_high_water_mark(struct umac_data*u,unsigned n) { (void)u;(void)n; }
static unsigned cancelled;
static int umac_core_cancel_timeout(struct umac_data*u,void(*f)(void*,void*),void*a,void*b) { (void)u;(void)f;(void)a;(void)b;++cancelled;return 1; }
static void datapath_defrag_deinit(struct umac_data*u,int*d) { (void)u;(void)d; }
static void umac_datapath_stad_flush_txq(struct umac_data*u,struct umac_sta_data*s) { (void)u;(void)s; }
#include "reorder.inc"
static struct umac_data u;
static struct umac_sta_data sta;
static void rx(unsigned tid,unsigned seq) {
struct mmpkt*p=calloc(1,sizeof(*p));assert(p);++live;p->hdr.base.frame_control=8;p->hdr.base.sequence_control=seq*16;p->qos.field=tid;p->read_timestamp_ms=now;
umac_datapath_process_rx_data_frame(&u,&sta,p,p);
}
int main(void) {
for(unsigned t=0;t<8;++t) { sta.expected[t]=10*16;sta.win[t]=4; }
rx(0,11);rx(2,11);rx(3,11); assert(live==3&&timers==1&&delivered[0]==0&&delivered[2]==0);
rx(2,10);assert(delivered[2]==2&&delivered[0]==0&&live==2);
rx(0,11);assert(dup_count==1&&live==2);
rx(0,10);assert(delivered[0]==2&&live==1);
rx(0,10);assert(late_count==1);
now=99;umac_datapath_rx_reorder_timeout_handler(&u,&sta);assert(delivered[3]==0);
now=100;umac_datapath_rx_reorder_timeout_handler(&u,&sta);assert(delivered[3]==1&&timeout_count==1&&live==0);
rx(1,12);rx(2,13);umac_datapath_flush_rx_reorder_list_for_tid(&sta,1);assert(live==1&&delivered[2]==2);
umac_datapath_flush_rx_reorder_list_for_tid(&sta,99);assert(live==1);
umac_datapath_flush_rx_reorder_list_for_tid(&sta,2);assert(live==0);
umac_datapath_rx_reorder_timeout_handler(&u,&sta);
sta.expected[0]=4095*16;rx(0,0);rx(0,4095);assert(last[0]==0&&live==0);
sta.win[4]=2;rx(4,11);rx(4,12);rx(4,13);assert(overflow_count==1&&mmpkt_list_length(&sta.data.rx_reorder_list[4])<=2);
for(unsigned t=0;t<8;++t)umac_datapath_flush_rx_reorder_list_for_tid(&sta,t);
umac_datapath_rx_reorder_timeout_handler(&u,&sta);
timer_ok=false;rx(5,11);assert(live==0&&!sta.data.rx_reorder_timer_pending);
timer_ok=true;rx(6,11);rx(7,11);assert(live==2);
umac_datapath_stad_flush(&u,&sta);assert(live==0&&cancelled==1&&!sta.data.rx_reorder_timer_pending);
puts("RX reorder: interleaved TIDs, gaps, duplicates, late packets, expiry, targeted flush, wrap, bounds and timer failure passed");
}
