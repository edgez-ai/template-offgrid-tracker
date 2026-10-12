/* Host regression harness; production function is extracted by run.py. */
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <openssl/evp.h>
#define le16toh(x) (x)
#define DOT11_CCMP_HEADER_LEN 8
#define DOT11_CCMP_128_MIC_LEN 8
#define MMWLAN_MAC_ADDR_LEN 6
#define UMAC_KEY_TYPE_PAIRWISE 1
#define UMAC_KEY_RX_COUNTER_SPACE_IND_ROBUST_MGMT 0
#define DOT11_MASK_FC_RETRY 0x800
#define DOT11_MASK_FC_MORE_DATA 0x2000
#define DOT11_MASK_FC_PROTECTED 0x4000
#define MM_ARRAY_COUNT(x) (sizeof(x)/sizeof((x)[0]))
#define MESH_DBG_PRINTF(...) ((void)0)
#define dp_mesh_dbg(...) ((void)0)
struct dot11_hdr { uint16_t frame_control, duration; uint8_t addr1[6],addr2[6],addr3[6]; uint16_t sequence_control; };
struct umac_data { int failures; };
struct umac_sta_data { uint8_t peer[6],key[16]; uint64_t pn; };
struct mmpktview { uint8_t bytes[128]; size_t start,len; };
struct ops { struct umac_sta_data *(*lookup_stad_by_peer_addr)(struct umac_data *,const uint8_t *); };
struct umac_datapath_data { bool mesh_mode; struct {bool valid; uint8_t key_id,peer_addr[6],key[16];size_t key_len;uint64_t rx_seq[1];} mesh_peer_group_keys[1]; struct ops *ops; };
static bool mm_mac_addr_is_multicast(const uint8_t *a) {return a[0]&1;}
static size_t mmpkt_get_data_length(struct mmpktview *v){return v->len;}
static uint8_t *mmpkt_get_data_start(struct mmpktview *v){return v->bytes+v->start;}
static uint8_t *mmpkt_remove_from_start(struct mmpktview *v,size_t n){uint8_t *p=mmpkt_get_data_start(v);assert(n<=v->len);v->start+=n;v->len-=n;return p;}
static void mmpkt_remove_from_end(struct mmpktview *v,size_t n){assert(n<=v->len);v->len-=n;}
static uint8_t *mmpkt_prepend(struct mmpktview *v,size_t n){assert(n<=v->start);v->start-=n;v->len+=n;return mmpkt_get_data_start(v);}
static int umac_keys_get_key_type(struct umac_sta_data *s,int k){return 1;}
static const uint8_t *umac_sta_data_peek_peer_addr(struct umac_sta_data *s){return s->peer;}
static const uint8_t *umac_keys_get_key_data(struct umac_sta_data *s,int k){return s->key;}
static size_t umac_keys_get_key_len(struct umac_sta_data *s,int k){return 16;}
static void umac_stats_increment_datapath_rx_ccmp_failures(struct umac_data *s){s->failures++;}
static bool ccmp_is_valid(struct umac_sta_data *s,uint8_t *h,int space){uint64_t pn=h[0]|((uint64_t)h[1]<<8)|((uint64_t)h[4]<<16)|((uint64_t)h[5]<<24)|((uint64_t)h[6]<<32)|((uint64_t)h[7]<<40);if(pn<=s->pn)return false;s->pn=pn;return true;}
static int aes_ccm_ad(const uint8_t *key,size_t kl,const uint8_t *nonce,size_t tl,const uint8_t *in,size_t n,const uint8_t *aad,size_t al,const uint8_t *tag,uint8_t *out){
 EVP_CIPHER_CTX *c=EVP_CIPHER_CTX_new();int len,ok;
 assert(EVP_DecryptInit_ex(c,EVP_aes_128_ccm(),NULL,NULL,NULL));
 assert(EVP_CIPHER_CTX_ctrl(c,EVP_CTRL_CCM_SET_IVLEN,13,NULL));
 assert(EVP_CIPHER_CTX_ctrl(c,EVP_CTRL_CCM_SET_TAG,tl,(void *)tag));
 assert(EVP_DecryptInit_ex(c,NULL,NULL,key,nonce));
 assert(EVP_DecryptUpdate(c,NULL,&len,NULL,n));
 assert(EVP_DecryptUpdate(c,NULL,&len,aad,al));
 ok=EVP_DecryptUpdate(c,out,&len,in,n);EVP_CIPHER_CTX_free(c);return ok?0:-1;
}
#define MMDRV_RX_FLAG_DECRYPTED 1
#define MMLOG_WRN(...) ((void)0)
struct mmdrv_rx_metadata { unsigned flags; };
struct mmpkt { struct mmdrv_rx_metadata meta; };
static struct mmpkt packet;
static struct umac_datapath_data *active_dp;
static bool dot11_frame_control_get_protected(uint16_t f){return (f&0x4000)!=0;}
static struct mmpkt *mmpkt_from_view(struct mmpktview *v){return &packet;}
static const struct mmdrv_rx_metadata *mmdrv_get_rx_metadata(struct mmpkt *p){return &p->meta;}
static struct umac_datapath_data *umac_data_get_datapath(struct umac_data *u){return active_dp;}
static const uint8_t *dot11_get_ra(const struct dot11_hdr *h){return h->addr1;}
#include "mgmt_under_test.inc"
static struct mmpktview make_frame_to(struct umac_sta_data *s,uint8_t pn,bool group){
 struct mmpktview v={.len=49};struct dot11_hdr h={.frame_control=0x40d0,.addr1={2},.addr3={4}};if(group) h.addr1[0]=3;memcpy(h.addr2,s->peer,6);memcpy(v.bytes,&h,24);
 uint8_t *cc=v.bytes+24;cc[0]=pn;cc[3]=group?0x60:0x20;
 uint8_t nonce[13]={0x10},aad[22]={0xd0,0x40};memcpy(nonce+1,s->peer,6);nonce[12]=pn;memcpy(aad+2,h.addr1,6);memcpy(aad+8,h.addr2,6);memcpy(aad+14,h.addr3,6);
 uint8_t body[9]={3,129,7,0,0,2,8,0,0};int len;
 EVP_CIPHER_CTX *c=EVP_CIPHER_CTX_new();assert(EVP_EncryptInit_ex(c,EVP_aes_128_ccm(),NULL,NULL,NULL));assert(EVP_CIPHER_CTX_ctrl(c,EVP_CTRL_CCM_SET_IVLEN,13,NULL));assert(EVP_CIPHER_CTX_ctrl(c,EVP_CTRL_CCM_SET_TAG,8,NULL));assert(EVP_EncryptInit_ex(c,NULL,NULL,s->key,nonce));assert(EVP_EncryptUpdate(c,NULL,&len,NULL,9));assert(EVP_EncryptUpdate(c,NULL,&len,aad,22));assert(EVP_EncryptUpdate(c,cc+8,&len,body,9));assert(EVP_EncryptFinal_ex(c,cc+17,&len));assert(EVP_CIPHER_CTX_ctrl(c,EVP_CTRL_CCM_GET_TAG,8,cc+17));EVP_CIPHER_CTX_free(c);return v;
}
static struct mmpktview make_frame(struct umac_sta_data *s,uint8_t pn){return make_frame_to(s,pn,false);}
static struct umac_sta_data *known_peer;
static struct umac_sta_data *lookup(struct umac_data *u,const uint8_t *a){return known_peer;}
int main(void){
 struct umac_sta_data s={.peer={6,1,2,3,4,5},.key={9}};struct umac_data u={0};struct umac_datapath_data d={.mesh_mode=true};active_dp=&d;
 struct mmpktview good=make_frame(&s,1),v=good;
 assert(umac_datapath_process_mgmt_frame_ccmp_header(&u,&s,&v));assert(s.pn==1&&v.len==33&&mmpkt_get_data_start(&v)[24]==3&&mmpkt_get_data_start(&v)[25]==129);
 v=good;assert(!mesh_sw_ccmp_decrypt_mgmt(&u,&s,&d,&v));assert(s.pn==1);
 for(int i=0;i<8;i++){v=make_frame(&s,2);v.bytes[41+i]^=1;assert(!mesh_sw_ccmp_decrypt_mgmt(&u,&s,&d,&v));assert(s.pn==1);}
 v=make_frame(&s,2);v.bytes[4]^=2;assert(!mesh_sw_ccmp_decrypt_mgmt(&u,&s,&d,&v));assert(s.pn==1);
 v=make_frame(&s,2);v.bytes[10]^=2;assert(!mesh_sw_ccmp_decrypt_mgmt(&u,&s,&d,&v));
 v=make_frame(&s,2);v.bytes[27]=0x60;assert(!mesh_sw_ccmp_decrypt_mgmt(&u,&s,&d,&v));
 v=make_frame(&s,2);v.bytes[27]=0;assert(!mesh_sw_ccmp_decrypt_mgmt(&u,&s,&d,&v));
 v=make_frame(&s,2);assert(!mesh_sw_ccmp_decrypt_mgmt(&u,NULL,&d,&v));
 for(int n=0;n<41;n++){v=good;v.len=n;assert(!mesh_sw_ccmp_decrypt_mgmt(&u,&s,&d,&v));}
 v=make_frame(&s,2);assert(mesh_sw_ccmp_decrypt_mgmt(&u,&s,&d,&v));assert(s.pn==2);
 struct ops ops={.lookup_stad_by_peer_addr=lookup};known_peer=&s;d.ops=&ops;
 d.mesh_peer_group_keys[0].valid=true;d.mesh_peer_group_keys[0].key_id=1;d.mesh_peer_group_keys[0].key_len=16;
 memcpy(d.mesh_peer_group_keys[0].peer_addr,s.peer,6);memcpy(d.mesh_peer_group_keys[0].key,s.key,16);
 v=make_frame_to(&s,1,true);assert(umac_datapath_process_mgmt_frame_ccmp_header(&u,&s,&v));assert(d.mesh_peer_group_keys[0].rx_seq[0]==1&&s.pn==2);
 v=make_frame_to(&s,1,true);assert(!umac_datapath_process_mgmt_frame_ccmp_header(&u,&s,&v));
 puts("Multicast MGTK authentication and independent replay counter passed");
 puts("Management CCMP: valid ADDBA, replay, forged MIC/AAD/sender, key ID, ExtIV, missing peer, truncation passed");
}
