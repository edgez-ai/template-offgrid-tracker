#include "edgez_mesh_ndp.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

/* Independent checksum over the IPv6 pseudo-header and ICMPv6 message. */
static unsigned sum(const unsigned char *f)
{
    unsigned n = f[18] * 256 + f[19], s = n + 58;
    for (unsigned i = 22; i < 54 + n; i += 2) s += f[i] * 256 + f[i + 1];
    while (s >> 16) s = (s & 65535) + (s >> 16);
    return s;
}
static void sign_frame(unsigned char *f)
{
    f[56] = f[57] = 0;
    unsigned c = (~sum(f)) & 65535;
    f[56] = c >> 8; f[57] = c;
}
int main(void)
{
    const unsigned char mac[6] = {0xb4, 0x3a, 0x45, 0xa4, 0x56, 0x74};
    const unsigned char self[16] = {0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0xb6, 0x3a, 0x45, 0xff, 0xfe, 0xa4, 0x56, 0x74};
    unsigned char f[86] = {0}, out[86];
    const unsigned char peer[6] = {2, 0, 0, 0, 0, 1};
    assert(edgez_mesh_ndp_advertisement(mac, peer, self, out, sizeof(out)) == 86);
    assert(sum(out) == 65535 && out[54] == 136 && out[58] == 0x20);
    assert(out[0] == 0x33 && out[1] == 0x33 && out[5] == 1);
    assert(!memcmp(out + 22, self, 16) && !memcmp(out + 62, self, 16));
    assert(out[38] == 0xff && out[39] == 2 && out[53] == 1);
    assert(out[78] == 2 && out[79] == 1 && !memcmp(out + 80, mac, 6));
    assert(!edgez_mesh_ndp_advertisement(mac, peer, self, out, 85));
    assert(!edgez_mesh_ndp_advertisement(mac, peer, (unsigned char[16]){0}, out, 86));
    f[6] = 2; f[11] = 1; f[12] = 0x86; f[13] = 0xdd;
    f[14] = 0x60; f[19] = 32; f[20] = 58; f[21] = 255;
    f[22] = 0xfe; f[23] = 0x80; f[37] = 1;
    memcpy(f + 38, self, 16); memcpy(f + 62, self, 16);
    f[54] = 135; f[78] = 1; f[79] = 1; memcpy(f + 80, f + 6, 6);
    sign_frame(f);
    assert(edgez_mesh_ndp_reply(mac, f, sizeof(f), out, sizeof(out)) == 86);
    assert(sum(out) == 65535 && out[54] == 136 && out[58] == 0x60);
    assert(!memcmp(out, f + 6, 6) && !memcmp(out + 38, f + 22, 16));
    assert(out[78] == 2 && out[79] == 1 && !memcmp(out + 80, mac, 6));
    for (size_t n = 0; n < sizeof(f); ++n) assert(!edgez_mesh_ndp_reply(mac, f, n, out, sizeof(out)));
    assert(!edgez_mesh_ndp_reply(mac, f, sizeof(f), out, 85));
    f[21] = 64; assert(!edgez_mesh_ndp_reply(mac, f, 86, out, 86)); f[21] = 255;
    f[56] ^= 1; assert(!edgez_mesh_ndp_reply(mac, f, 86, out, 86)); sign_frame(f);
    f[77] ^= 1; sign_frame(f); assert(!edgez_mesh_ndp_reply(mac, f, 86, out, 86)); f[77] ^= 1;
    f[79] = 0; sign_frame(f); assert(!edgez_mesh_ndp_reply(mac, f, 86, out, 86));
    f[79] = 2; sign_frame(f); assert(!edgez_mesh_ndp_reply(mac, f, 86, out, 86)); f[79] = 1;
    /* Multicast resolution, followed by DAD. */
    memset(f + 38, 0, 16);
    f[38] = 0xff; f[39] = 2; f[49] = 1; f[50] = 0xff;
    memcpy(f + 51, self + 13, 3);
    sign_frame(f); assert(edgez_mesh_ndp_reply(mac, f, 86, out, 86) == 86);
    assert(sum(out) == 65535 && out[58] == 0x60);
    /* DAD must use solicited-node multicast and contain no source LL option. */
    memset(f + 22, 0, 16);
    sign_frame(f); assert(!edgez_mesh_ndp_reply(mac, f, 86, out, 86));
    f[19] = 24; sign_frame(f);
    assert(edgez_mesh_ndp_reply(mac, f, 78, out, 86) == 86);
    assert(sum(out) == 65535 && out[58] == 0x20 && out[0] == 0x33 && out[53] == 1);
    puts("EdgeZ Mesh Network NDP tests passed");
}
