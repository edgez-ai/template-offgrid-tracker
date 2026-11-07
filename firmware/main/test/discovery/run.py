from pathlib import Path
import subprocess,tempfile
root=Path(__file__).resolve().parents[3]
sdk=root.parent.parent/'edgez-halow-mesh'
with tempfile.TemporaryDirectory() as directory:
 path=Path(directory)
 source=(root/'main/halow_discovery.c').read_text()
 (path/'discovery.inc').write_text('\n'.join(line for line in source.splitlines() if not line.startswith('#include')))
 subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror','-fsanitize=address,undefined',
    '-I'+str(path),'-I'+str(sdk/'include'),str(Path(__file__).with_name('test.c')),
    str(sdk/'common/src/edgez_pawr_protocol.c'),'-o',str(path/'test')],check=True)
 subprocess.run([str(path/'test')],check=True)
