#!/usr/bin/env python3
"""Compile the production management decrypt function with packet/key stubs and OpenSSL."""
from pathlib import Path
import subprocess
import tempfile
root = Path(__file__).resolve().parents[3]
source = (root / 'third_party/esp-halow/halow/components/mm-iot-sdk/framework/morselib/src/umac/datapath/umac_datapath.c').read_text()
start = source.index('static bool mesh_sw_ccmp_decrypt_mgmt(')
end = source.index('\n/**', start)
with tempfile.TemporaryDirectory() as tmp:
    gate = source.index('static bool umac_datapath_process_mgmt_frame_ccmp_header(')
    gate_end = source.index('\n}', gate)+2
    (Path(tmp) / 'mgmt_under_test.inc').write_text(source[start:end]+source[gate:gate_end])
    subprocess.run(['cc', '-g', '-fsanitize=address,undefined', '-I'+tmp,
        '-I/usr/local/opt/openssl@3/include', str(Path(__file__).with_name('test_mgmt.c')),
        '-L/usr/local/opt/openssl@3/lib', '-lcrypto', '-o', tmp+'/test'], check=True)
    subprocess.run([tmp+'/test'], check=True)

source = (root / 'third_party/esp-halow/halow/components/mm-iot-sdk/framework/morselib/src/umac/ba/umac_ba.c').read_text()
def function(name):
    marker = ({'umac_ba_calculate_addba_attempt_backoff': 'static uint32_t ',
               'umac_ba_select_addba_dialog_token': 'static uint8_t '}.get(name, 'static void '))
    start = source.index(marker+name+'(')
    end = source.index('\n}', start)+2
    return source[start:end]
with tempfile.TemporaryDirectory() as tmp:
    (Path(tmp) / 'ba_under_test.inc').write_text(
        function('umac_ba_calculate_addba_attempt_backoff')+'\n'+
        function('umac_ba_select_addba_dialog_token')+'\n'+
        function('umac_ba_addba_req_timeout_handler')+'\n'+
        function('umac_ba_rx_addba_resp'))
    subprocess.run(['cc', '-g', '-fsanitize=address,undefined', '-I'+tmp,
        str(Path(__file__).with_name('test_ba.c')), '-o', tmp+'/test'], check=True)
    subprocess.run([tmp+'/test'], check=True)
