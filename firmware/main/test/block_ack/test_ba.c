/* Exercise the actual BA response/timeout handlers with transport/timer stubs. */
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#define MMLOG_DBG(...) ((void)0)
#define MMLOG_WRN(...) ((void)0)
#define MMLOG_ERR(...) ((void)0)
#define MM_MAC_ADDR_FMT "%u"
#define MM_MAC_ADDR_VAL(x) 0U
#define le16toh(x) (x)
#define UMAC_BA_MAX_SESSIONS 8
#define UMAC_BA_DISABLED 0
#define UMAC_BA_REQUESTED 1
#define UMAC_BA_SUCCESS 2
#define UMAC_BA_REFUSED 3
#define DOT11_STATUS_SUCCESS 0
#define DOT11_BA_POLICY_IMMEDIATE 1
#define DOT11_DELBA_INITIATOR_ORIGINATOR 1
#define DOT11_REASON_UNSPECIFIED 1
#define DOT11_REASON_INACTIVITY 4
#define ADDBA_REQ_BASE_TIMEOUT_MS 1500
#define ADDBA_REQ_MULTIPLIER 2
#define ADDBA_REQ_MAX_TIMEOUT_MS 12000
#define BA_PERF_REQ_TIMEOUT 0
#define BA_PERF_RESP_RX 1
#define BA_PERF_REFUSED 2
#define BA_PERF_ORIGINATOR_OK 3
struct umac_ba_session {int status;uint8_t tid,dialog_token;uint16_t buffer_size;uint32_t attempt_backoff;};
struct umac_ba_sta_data {struct {struct umac_ba_session originator[8];} sessions;};
struct umac_sta_data {struct umac_ba_sta_data ba;};
struct umac_data {int dummy;};
struct dot11_action_field_addba_resp {uint8_t category,action,dialog_token;uint16_t status_code,ba_param_set;} __attribute__((packed));
enum mmwlan_status {MMWLAN_SUCCESS,MMWLAN_ERROR};
static int cancelled,registered,register_fail,delba_fail,delba_calls,legacy_delba_calls;
static uint32_t random_calls;
static uint32_t last_register_ms;
static int last_delba_initiator,last_delba_tid,last_delba_reason;
static struct umac_data u;
static void umac_ba_perf_count(int c){}
static struct umac_ba_sta_data *umac_sta_data_get_ba(struct umac_sta_data *s){return &s->ba;}
static struct umac_data *umac_sta_data_get_umacd(struct umac_sta_data *s){return &u;}
static uint8_t dot11_ba_parameter_set_field_get_tid(uint16_t x){return (x>>2)&15;}
static uint16_t dot11_ba_parameter_set_field_get_buffer_size(uint16_t x){return x>>6;}
static int dot11_ba_parameter_set_field_get_ba_policy(uint16_t x){return (x>>1)&1;}
static uint16_t min_u16(uint16_t a,uint16_t b){return a<b?a:b;}
static uint32_t mmhal_random_u32(uint32_t lo,uint32_t hi){(void)hi;random_calls++;return lo+76;}
static enum mmwlan_status umac_ba_tx_delba(struct umac_sta_data *s,int i,int t,int r){delba_calls++;last_delba_initiator=i;last_delba_tid=t;last_delba_reason=r;return delba_fail?MMWLAN_ERROR:MMWLAN_SUCCESS;}
static enum mmwlan_status umac_ba_tx_legacy_delba(struct umac_sta_data *s,int i,int t,int r){legacy_delba_calls++;return delba_fail?MMWLAN_ERROR:MMWLAN_SUCCESS;}
static void umac_core_cancel_timeout(struct umac_data *d,void (*f)(void*,void*),void *a,void *b){cancelled++;}
static bool umac_core_register_timeout(struct umac_data *d,uint32_t ms,void (*f)(void*,void*),void *a,void *b){registered++;last_register_ms=ms;return !register_fail;}
#include "ba_under_test.inc"
int main(void){
 struct umac_sta_data s={0};struct umac_ba_session *b=&s.ba.sessions.originator[0];
 struct dot11_action_field_addba_resp r={.dialog_token=9,.ba_param_set=2|(16<<6)};
 assert(umac_ba_calculate_addba_attempt_backoff(0)==1500);
 assert(umac_ba_calculate_addba_attempt_backoff(1500)==3000);
 assert(umac_ba_calculate_addba_attempt_backoff(6000)==12000);
 assert(umac_ba_calculate_addba_attempt_backoff(12000)==12000);
 assert(umac_ba_select_addba_dialog_token(23)==23&&random_calls==0);
 assert(umac_ba_select_addba_dialog_token(0)==77&&random_calls==1);
 b->status=UMAC_BA_REQUESTED;b->dialog_token=8;b->buffer_size=32;
 umac_ba_rx_addba_resp(&s,(const uint8_t *)&r,sizeof(r));assert(cancelled==0&&b->status==UMAC_BA_REQUESTED);
 r.dialog_token=8;umac_ba_rx_addba_resp(&s,(const uint8_t *)&r,sizeof(r)-1);assert(cancelled==0);
 b->attempt_backoff=5000;umac_ba_rx_addba_resp(&s,(const uint8_t *)&r,sizeof(r));assert(cancelled==1&&b->status==UMAC_BA_SUCCESS&&b->buffer_size==16&&b->attempt_backoff==0);
 b->status=UMAC_BA_REQUESTED;b->attempt_backoff=1500;r.status_code=37;umac_ba_rx_addba_resp(&s,(const uint8_t *)&r,sizeof(r));assert(b->status==UMAC_BA_REFUSED&&registered==1&&delba_calls==1&&legacy_delba_calls==1&&last_delba_initiator==DOT11_DELBA_INITIATOR_ORIGINATOR&&last_delba_tid==0&&last_delba_reason==DOT11_REASON_UNSPECIFIED);
 assert(b->attempt_backoff==1500&&last_register_ms==1500);
 umac_ba_addba_req_timeout_handler(&s,b);assert(b->status==UMAC_BA_DISABLED&&b->dialog_token==0);
 b->status=UMAC_BA_REQUESTED;b->dialog_token=8;register_fail=1;umac_ba_rx_addba_resp(&s,(const uint8_t *)&r,sizeof(r));assert(b->status==UMAC_BA_DISABLED&&registered==2);register_fail=0;
 b->status=UMAC_BA_REQUESTED;r.status_code=0;r.ba_param_set=16<<6;umac_ba_rx_addba_resp(&s,(const uint8_t *)&r,sizeof(r));assert(b->status==UMAC_BA_DISABLED);
 b->status=UMAC_BA_REQUESTED;b->dialog_token=51;delba_fail=1;int old_delba_calls=delba_calls;
 umac_ba_addba_req_timeout_handler(&s,b);
 assert(b->status==UMAC_BA_DISABLED&&b->dialog_token==51&&delba_calls==old_delba_calls);
 puts("BA: token reuse, wrong token, success, refusal cleanup/backoff, timer failure and delayed policy passed");
}
