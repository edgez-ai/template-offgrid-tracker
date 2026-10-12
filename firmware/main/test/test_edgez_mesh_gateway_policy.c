#include "edgez_mesh_gateway_policy.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static void test_decode(void)
{
    /* Exact Gateway protobuf fields from openmanetd 1.3.3. */
    const uint8_t wire[] = "\x0a\x11" "02:11:22:33:44:55" "\x12\x04" "gate" "\x1a\x09" "10.41.0.1";
    edgez_mesh_gateway_record_t r;
    assert(edgez_mesh_gateway_decode(wire, sizeof(wire) - 1, &r));
    assert(r.valid && r.mac[0] == 2 && r.mac[5] == 0x55);
    assert(!memcmp(r.ip, (uint8_t[]){10,41,0,1}, 4));
    for (size_t i = 0; i < sizeof(wire) - 1; ++i) assert(!edgez_mesh_gateway_decode(wire, i, &r));
    const uint8_t multicast[] = "\x0a\x11" "03:11:22:33:44:55" "\x1a\x09" "10.41.0.1";
    assert(!edgez_mesh_gateway_decode(multicast, sizeof(multicast) - 1, &r));
    const uint8_t bad_ip[] = "\x0a\x11" "02:11:22:33:44:55" "\x1a\x0b" "999.41.0.1!";
    assert(!edgez_mesh_gateway_decode(bad_ip, sizeof(bad_ip) - 1, &r));
    const uint8_t bad_varint[] = {0x0a,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0x7f};
    assert(!edgez_mesh_gateway_decode(bad_varint, sizeof(bad_varint), &r));
    uint8_t extended[sizeof(wire) + 2];
    memcpy(extended, wire, sizeof(wire) - 1);
    extended[sizeof(wire)-1] = 0x20; extended[sizeof(wire)] = 1;
    assert(edgez_mesh_gateway_decode(extended, sizeof(wire) + 1, &r));
}

static void test_selection(void)
{
    edgez_mesh_gateway_policy_t s = {0};
    edgez_mesh_gateway_record_t a = {.mac={2,0,0,0,0,1}, .ip={10,41,0,1}, .valid=true};
    edgez_mesh_gateway_record_t b = {.mac={2,0,0,0,0,2}, .ip={10,41,0,2}, .valid=true};
    edgez_mesh_gateway_route_t routes[] = {
        {.mac={2,0,0,0,0,1}, .tq=200, .down=100, .up=20, .gateway=true},
        {.mac={2,0,0,0,0,2}, .tq=210, .down=100, .up=20, .gateway=true},
    };
    assert(!edgez_mesh_gateway_select(&s, routes, 2, 0)); // MAC-only routes are not usable.
    edgez_mesh_gateway_record(&s, &a, 0);
    assert(edgez_mesh_gateway_select(&s, routes, 2, 1));
    assert(s.selected.mac[5] == 1);
    edgez_mesh_gateway_record(&s, &b, 2);
    assert(!edgez_mesh_gateway_select(&s, routes, 2, 3)); // Hold period.
    assert(!edgez_mesh_gateway_select(&s, routes, 2, 20000)); // Less than 20% better.
    routes[1].tq = 250;
    assert(edgez_mesh_gateway_select(&s, routes, 2, 20001));
    assert(s.selected.mac[5] == 2);
    routes[1].gateway = false;
    assert(edgez_mesh_gateway_select(&s, routes, 2, 20002)); // Withdrawal bypasses hold.
    assert(s.selected.mac[5] == 1);
    a.ip[3] = 9; edgez_mesh_gateway_record(&s, &a, 20003);
    assert(edgez_mesh_gateway_select(&s, routes, 2, 20004)); // Same MAC, changed IP.
    assert(s.selected.ip[3] == 9);
    routes[0].tq = 0;
    assert(edgez_mesh_gateway_select(&s, routes, 2, 20005));
    assert(!s.selected.valid);
    routes[0].tq = 200;
    assert(edgez_mesh_gateway_select(&s, routes, 2, 20006));
    assert(edgez_mesh_gateway_select(&s, routes, 2, 20003 + EDGEZ_MESH_GATEWAY_RECORD_TTL_MS));
    assert(!s.selected.valid);
    edgez_mesh_gateway_record(&s, &a, UINT32_MAX - 10);
    assert(edgez_mesh_gateway_select(&s, routes, 2, 5)); // Timer wrap.
    assert(s.selected.valid);
    assert(edgez_mesh_gateway_select(&s, routes, 0, 6)); // No route.
}

static void test_ezgw(void)
{
    const uint8_t owner[6] = {0x0c,0xbf,0x74,0x1a,0xae,0x36};
    const char *wire = "EZGW1 e72e7401 00004006 10.41.71.1 100000 100000 0 45";
    edgez_mesh_gateway_record_t r;
    assert(edgez_mesh_gateway_decode_ezgw((const uint8_t *)wire, strlen(wire), owner, &r));
    assert(r.modern && r.valid && r.sequence == 0x4006 && r.lifetime_ms == 45000);
    assert(!memcmp(r.ip, (uint8_t[]){10,41,71,1}, 4));
    for (size_t n = 0; n < strlen(wire); ++n)
        assert(!edgez_mesh_gateway_decode_ezgw((const uint8_t *)wire, n, owner, &r));
    const char *bad[] = {
        "EZGW1 e72e7401 00004006 999.41.71.1 100000 100000 0 45",
        "EZGW1 e72e7401 00004006 10.41.71.1 0 100000 0 45",
        "EZGW1 e72e7401 00004006 10.41.71.1 100000 100000 101 45",
        "EZGW1 e72e7401 00004006 10.41.71.1 100000 100000 0 46",
        "EZGW1 e72e7401 00004006 10.41.71.1 100000 100000 0 45 ",
    };
    for (size_t i = 0; i < sizeof(bad)/sizeof(bad[0]); ++i)
        assert(!edgez_mesh_gateway_decode_ezgw((const uint8_t *)bad[i], strlen(bad[i]), owner, &r));
    edgez_mesh_gateway_policy_t policy = {0};
    /* Modern records provide bandwidth; BATMAN supplies reachability and TQ. */
    edgez_mesh_gateway_route_t route = {.tq=240, .gateway=true};
    memcpy(route.mac, owner, 6);
    edgez_mesh_gateway_record(&policy, &r, 1000);
    assert(!edgez_mesh_gateway_select(&policy, &route, 1, 1001));
    ++r.sequence;
    edgez_mesh_gateway_record(&policy, &r, 2000);
    assert(edgez_mesh_gateway_select(&policy, &route, 1, 2001));
    assert(policy.selected.valid);
    /* Re-reading cached values must not extend their lifetime. */
    edgez_mesh_gateway_record(&policy, &r, 46000);
    assert(edgez_mesh_gateway_select(&policy, &route, 1, 47000));
    assert(!policy.selected.valid);
    ++r.sequence;
    edgez_mesh_gateway_record(&policy, &r, 48000);
    assert(edgez_mesh_gateway_select(&policy, &route, 1, 48001));
    ++r.sequence;
    r.valid = false;
    r.lifetime_ms = 0;
    edgez_mesh_gateway_record(&policy, &r, 49000);
    assert(edgez_mesh_gateway_select(&policy, &route, 1, 49001));
    assert(!policy.selected.valid);
    r.valid = true; r.lifetime_ms = 45000; ++r.session;
    edgez_mesh_gateway_record(&policy, &r, 50000);
    assert(!edgez_mesh_gateway_select(&policy, &route, 1, 50001));
    ++r.sequence;
    edgez_mesh_gateway_record(&policy, &r, 51000);
    assert(edgez_mesh_gateway_select(&policy, &route, 1, 51001));
}

int main(void)
{
    test_decode(); test_selection(); test_ezgw();
    puts("EdgeZ Mesh Network gateway policy tests passed");
}
