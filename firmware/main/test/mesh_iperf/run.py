#!/usr/bin/env python3
from pathlib import Path
import subprocess,tempfile
root=Path(__file__).resolve().parents[3]
source=(root/'main/edgez_mesh_iperf.c').read_text()
# Compile the actual callback/lifecycle implementation against a small TCP fake.
source='\n'.join(l for l in source.splitlines() if not l.startswith('#include'))
with tempfile.TemporaryDirectory() as t:
    Path(t,'server.inc').write_text(source)
    subprocess.run(['cc','-std=c11','-fsanitize=address,undefined','-I'+t,str(Path(__file__).with_name('test.c')),'-o',t+'/test'],check=True)
    subprocess.run([t+'/test'],check=True)
