#!/usr/bin/env python3
from pathlib import Path
import subprocess, tempfile
root = Path(__file__).resolve().parents[3]
s = (root/'third_party/esp-halow/halow/components/mm-iot-sdk/framework/morselib/src/umac/datapath/umac_datapath.c').read_text()
a=s.index('static void umac_datapath_flush_rx_reorder_list(')
b=s.index('\n}\n', s.index('static void umac_datapath_process_rx_data_frame(',a))+3
flush_start=s.index('void umac_datapath_stad_flush(struct')
flush_end=s.index('\n}\n',flush_start)+3
h=(root/'third_party/esp-halow/halow/components/mm-iot-sdk/framework/morselib/src/umac/datapath/umac_datapath_data.h').read_text()
fields=h[h.index('    /* Independent sequence'):h.index('\n};',h.index('    /* Independent sequence'))]
with tempfile.TemporaryDirectory() as t:
    Path(t,'fields.inc').write_text(fields)
    Path(t,'reorder.inc').write_text(s[a:b] + s[flush_start:flush_end])
    subprocess.run(['cc','-std=c11','-g','-fsanitize=address,undefined','-I'+t,str(Path(__file__).with_name('test.c')),'-o',t+'/test'],check=True)
    subprocess.run([t+'/test'],check=True)
