#!/usr/bin/env python3
"""Exercise the HC33/nRF factory wake test using CMSIS-DAP and serial.

Flash both matching test images first. An optional quiet phase closes OpenOCD
before USER commands, then reattaches without reset to read passive counters.
This never measures current, disconnects probe wiring, or proves RF sleep.
"""
import argparse
import hashlib
import json
import re
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import serial
from elftools.elf.elffile import ELFFile


COUNTERS = ('session', 'active', 'user_rx', 'ack_completed', 'ack_failed',
            'feedback_skipped', 'led_on', 'led_off', 'host_released')
ANSI = re.compile(r'\x1b\[[0-9;]*m')


def tcl(command):
    with socket.create_connection(('127.0.0.1', 6666), timeout=5) as sock:
        sock.sendall(command.encode() + b'\x1a')
        result = bytearray()
        while not result.endswith(b'\x1a'):
            part = sock.recv(65536)
            if not part:
                raise OSError('OpenOCD closed the TCL connection')
            result.extend(part)
            if len(result) > 131072:
                raise ValueError('Oversized TCL response')
        return result[:-1].decode()


def read_memory(address, width, count):
    values = [int(v, 0) for v in tcl(f'read_memory 0x{address:x} {width} {count}').split()]
    if len(values) != count:
        raise ValueError('Incomplete OpenOCD memory read')
    return values


def symbols(elf_path):
    with elf_path.open('rb') as stream:
        table = ELFFile(stream).get_section_by_name('.symtab')
        if table is None:
            raise ValueError('ELF has no symbol table')
        wanted = ['sensor_twt_test_' + name for name in COUNTERS]
        wanted += ['_SEGGER_RTT', 'sensor_twt_mac_snapshot', 'sensor_twt_mac_snapshot_length',
                   'sensor_twt_mac_snapshot_status', 'sensor_twt_test_capture_after_user']
        result = {}
        for name in wanted:
            found = table.get_symbol_by_name(name) or []
            if len(found) == 1:
                result[name] = (found[0]['st_value'], found[0]['st_size'])
        for name in COUNTERS:
            if result.get('sensor_twt_test_' + name, (0, 0))[1] != 4:
                raise ValueError(f'ELF lacks the four-byte test counter {name}')
        return result


def read_counters(table):
    return {name: read_memory(table['sensor_twt_test_' + name][0], 32, 1)[0]
            for name in COUNTERS}


def assess(session, counters, sent, acknowledgements):
    """Separate queued TX, application delivery, and returned ACK evidence."""
    return {
        'same_session': counters['session'] == session,
        'still_active': counters['active'] == 1,
        'all_delivered': sent > 0 and counters['user_rx'] == sent,
        'all_acknowledged': sent > 0 and acknowledgements == sent
            and counters['ack_completed'] == sent and counters['ack_failed'] == 0,
        'led_cycles_complete': counters['led_on'] == sent and counters['led_off'] == sent,
        'host_released': counters['host_released'] == 1,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--elf', type=Path, required=True, help='Exact flashed ELF')
    parser.add_argument('--hc33', default='/dev/cu.SLAB_USBtoUART')
    parser.add_argument('--probe', help='CMSIS-DAP serial')
    parser.add_argument('--mode', choices=['stateless', 'ap'], default='stateless')
    parser.add_argument('--duration', type=float, default=40, help='Seconds after HC33 ACTIVE')
    parser.add_argument('--wake-delays', default='8,21', help='Seconds after ACTIVE, comma-separated')
    parser.add_argument('--detach-after', type=float, help='Close debugger after this many ACTIVE seconds')
    parser.add_argument('--normal-boot', action='store_true',
                        help='Release debug power, pulse nRESET, then boot with no debugger')
    parser.add_argument('--leave-running', action='store_true',
                        help='With --normal-boot, skip final debug reattachment; report HC33 observations only')
    parser.add_argument('--physical-button', action='store_true',
                        help='With --leave-running, keep UART control lines deasserted and wait for a real USER press')
    parser.add_argument('--keep-beacons', action='store_true', help='Refresh AP test beacons every 24 seconds')
    parser.add_argument('--mesh-after-seed', type=float,
                        help='Send HC33 m after this many ACTIVE seconds to return its radio to mesh')
    parser.add_argument('--snapshot-after-user', action='store_true',
                        help='Opt in to RF snapshots after USER traffic, while its host wake is already held')
    parser.add_argument('--log', type=Path, required=True)
    args = parser.parse_args()
    delays = sorted(float(value) for value in args.wake_delays.split(','))
    if not delays or delays[0] < 1 or any(b-a < 8 for a, b in zip(delays, delays[1:])):
        parser.error('Wake delays must be at least one second and eight seconds apart')
    if args.duration < delays[-1] + 8:
        parser.error('Duration must allow eight seconds after the last command for TX and LED off')
    if args.detach_after is not None and not 18 <= args.detach_after < delays[0] - 1:
        parser.error('Detach after the 15-second snapshot and before the first command (18+ seconds)')
    if args.keep_beacons and args.mode != 'ap':
        parser.error('--keep-beacons requires --mode ap')
    if args.normal_boot and (args.detach_after is not None or args.snapshot_after_user):
        parser.error('--normal-boot cannot use --detach-after or debugger-set --snapshot-after-user')
    if args.leave_running and not args.normal_boot:
        parser.error('--leave-running requires --normal-boot')
    if args.physical_button and not args.leave_running:
        parser.error('--physical-button requires --leave-running')
    if args.mesh_after_seed is not None and (args.mode != 'ap' or args.keep_beacons
            or args.mesh_after_seed < 5 or delays[0] < args.mesh_after_seed + 5):
        parser.error('--mesh-after-seed requires AP mode, no beacon refresh, and five seconds before USER')
    args.elf = args.elf.resolve()
    args.log.parent.mkdir(parents=True, exist_ok=True)
    # PlatformIO can remove another environment's build output after a project
    # configuration change. Pin the exact ELF for the whole test and reattach.
    archived_elf = args.log.with_suffix('.elf').resolve()
    if archived_elf != args.elf:
        shutil.copy2(args.elf, archived_elf)
    args.elf = archived_elf
    elf_sha256 = hashlib.sha256(args.elf.read_bytes()).hexdigest()
    table = symbols(args.elf)
    if args.snapshot_after_user and table.get('sensor_twt_test_capture_after_user', (0, 0))[1] != 4:
        parser.error('ELF lacks capture-after-USER control')
    started = time.monotonic()
    server = None
    rtt = None
    port = serial.Serial()
    port.port, port.baudrate, port.timeout = args.hc33, 115200, 0
    port.dtr = port.rts = False
    buffers = {'NRF': '', 'HC33': ''}
    session = None
    active_at = ready_at = reset_at = beacon_at = None
    sent = acknowledgements = 0
    detached = False
    pre_detach = None
    debug_power = None
    reset_done = False
    mesh_requested = mesh_confirmed = False
    queued_sequences = []
    acknowledged_sequences = []
    with args.log.open('w') as output, args.log.with_suffix('.openocd.log').open('w') as server_log:
        def record(name, line):
            text = f'{time.monotonic()-started:.3f} [{name}] {line}'
            output.write(text + '\n')
            output.flush()
            if name == 'TEST' or any(s in line for s in ['PAWR_TWT', 'TWT_SYNC', 'TWT_AP', 'TWT_MESH', 'USER_PIN', '<err>']):
                print(text, flush=True)

        def start_server():
            nonlocal server, rtt
            try:
                existing = socket.create_connection(('127.0.0.1', 6666), timeout=0.2)
            except OSError:
                pass
            else:
                existing.close()
                raise RuntimeError('Port 6666 already has a server; close it before this managed test')
            command = [sys.executable, str(Path(__file__).with_name('nrf54_openocd.py')), 'serve']
            if '_SEGGER_RTT' in table:
                command += ['--elf', str(args.elf)]
            if args.probe:
                command += ['--serial', args.probe]
            server = subprocess.Popen(command, stdout=server_log, stderr=subprocess.STDOUT)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if server.poll() is not None:
                    raise RuntimeError('OpenOCD exited; inspect the .openocd.log')
                try:
                    if '_SEGGER_RTT' in table:
                        tcl('rtt polling_interval 5')
                        rtt = socket.create_connection(('127.0.0.1', 9090), timeout=2)
                        rtt.setblocking(False)
                    else:
                        tcl('version')
                    return
                except OSError:
                    time.sleep(0.1)
            raise TimeoutError('OpenOCD did not start')

        def stop_server():
            nonlocal server, rtt
            if rtt is not None:
                rtt.close()
                rtt = None
            if server is not None:
                if server.poll() is None:
                    try:
                        tcl('shutdown')
                    except OSError:
                        pass
                    server.wait(timeout=10)
                server = None

        def release_debug_power():
            # Arm ADIv5 DP CTRL/STAT [30,28] are system/debug power requests.
            # Stop AP polling first; subsequent reads are DP-only. For normal
            # boot the caller pulses nRESET after this step. The nRF DAP is
            # inaccessible while this board is held in pin reset.
            tcl('poll off' + ('; rtt stop' if '_SEGGER_RTT' in table else ''))
            before = int(tcl('capture {nrf54l.dap dpreg 4}').strip(), 0)
            tcl('nrf54l.dap dpreg 4 0')
            after = int(tcl('capture {nrf54l.dap dpreg 4}').strip(), 0)
            if after & 0x50000000:
                raise RuntimeError(f'Debug power requests did not clear: {after:#x}')
            record('TEST', f'DEBUG_POWER before={before:#x} after={after:#x} requests=0')
            return {'before': before, 'after': after, 'requests_cleared': True}

        def save_snapshot():
            prefix = 'sensor_twt_mac_snapshot'
            if prefix not in table:
                return
            status = read_memory(table[prefix + '_status'][0], 32, 1)[0]
            length = read_memory(table[prefix + '_length'][0], 32, 1)[0]
            if status != 0 or not 16 <= length <= min(table[prefix][1], 1600):
                raise ValueError(f'Snapshot not ready: status={status} length={length}')
            raw = bytes(read_memory(table[prefix][0], 8, length))
            args.log.with_suffix('.mac.bin').write_bytes(raw)
            record('TEST', f'Saved existing MAC snapshot bytes={length}; no RF query')

        def send(command):
            port.write(command.encode())
            record('TEST', f'HC33 command={command}')

        try:
            start_server()
            # A freshly flashed nRF can reach PAwR during the HC33 boot and
            # negotiate before the AP lab switch. Quiesce it until HC33 is
            # configured, then perform the selected fresh-reset sequence.
            tcl('halt')
            record('TEST', 'nRF halted during HC33 mode setup')
            port.open()
            port.rts = True
            time.sleep(0.1)
            port.rts = False
            while True:
                now = time.monotonic()
                if active_at is not None and now - active_at >= args.duration:
                    break
                if active_at is None and now - started > 35:
                    raise TimeoutError('HC33 never reached ACTIVE after the nRF reset')
                nrf = b''
                if rtt is not None:
                    try:
                        nrf = rtt.recv(65536)
                    except BlockingIOError:
                        pass
                for name, data in [('NRF', nrf), ('HC33', port.read(65536))]:
                    buffers[name] += data.decode(errors='replace')
                    lines = buffers[name].split('\n')
                    buffers[name] = lines.pop()
                    for raw in lines:
                        line = ANSI.sub('', raw).strip()
                        record(name, line)
                        if name != 'HC33':
                            continue
                        if 'TWT_AP_MODE requires fresh' in line or 'TWT_MESH_MODE requires AP' in line:
                            raise RuntimeError('HC33 refused the requested interface test mode')
                        if 'TWT_MESH_MODE start rc=0 same_mac=1 active=1' in line:
                            mesh_confirmed = True
                        if 'ready: USER' in line and ready_at is None:
                            ready_at = now
                        if reset_done and 'PAWR_TWT ACTIVE' in line:
                            match = re.search(r'session=(\d+)', line)
                            if match and active_at is None:
                                session, active_at = int(match.group(1)), now
                                if args.snapshot_after_user:
                                    tcl(f"mww 0x{table['sensor_twt_test_capture_after_user'][0]:x} 1")
                                    record('TEST', 'Enabled snapshots after real USER traffic')
                        if active_at is not None and 'PAWR_TWT TX sequence=' in line:
                            match = re.search(r'sequence=(\d+).*queued=1', line)
                            if match:
                                queued_sequences.append(int(match.group(1)))
                        if active_at is not None and 'PAWR_TWT STATS sequence=' in line:
                            match = re.search(r'sequence=(\d+)', line)
                            if match:
                                acknowledgements += 1
                                acknowledged_sequences.append(int(match.group(1)))
                        if active_at is not None and ('*** Booting' in line or 'ESP-ROM:' in line):
                            raise RuntimeError('HC33 reset during the active test')
                if ready_at is not None and reset_at is None and now - ready_at >= 1:
                    if args.mode == 'ap':
                        send('a')
                    reset_at = now + 2
                if reset_at is not None and not reset_done and now >= reset_at:
                    if args.mode == 'ap':
                        send('b')
                        beacon_at = now
                    if args.normal_boot:
                        # Nordic requires normal mode followed by a pin reset
                        # after debugging. Never use ERASEALL/recover here.
                        tcl('poll off; reset_config srst_only srst_nogate; '
                            'mww 0x5010e600 0xffffffff')
                        debug_power = release_debug_power()
                        tcl('adapter assert srst')
                        try:
                            time.sleep(0.1)
                        finally:
                            tcl('adapter deassert srst')
                        stop_server()
                        detached = True
                        record('TEST', 'NORMAL_BOOT nRESET released; debugger closed before firmware boot')
                    else:
                        tcl('reset run' + ('; rtt start' if '_SEGGER_RTT' in table else ''))
                    reset_done = True
                    record('TEST', 'nRF reset; fresh test session')
                if active_at is not None:
                    elapsed = now - active_at
                    if args.detach_after is not None and not detached and elapsed >= args.detach_after:
                        pre_detach = read_counters(table)
                        if pre_detach['session'] != session or pre_detach['active'] != 1:
                            raise RuntimeError(f'nRF session not active before detach: {pre_detach}')
                        save_snapshot()
                        snapshot_file = args.log.with_suffix('.mac.bin')
                        if snapshot_file.exists():
                            shutil.copy2(snapshot_file, args.log.with_suffix('.before-detach.mac.bin'))
                        record('TEST', 'BEFORE_DETACH ' + json.dumps(pre_detach))
                        debug_power = release_debug_power()
                        stop_server()
                        detached = True
                        record('TEST', 'DEBUGGER_CLOSED; probe wiring remains connected')
                    if sent < len(delays) and elapsed >= delays[sent]:
                        send('w')
                        sent += 1
                    if args.mesh_after_seed is not None and not mesh_requested and elapsed >= args.mesh_after_seed:
                        send('m')
                        mesh_requested = True
                if args.keep_beacons and beacon_at is not None and now - beacon_at >= 24:
                    send('b')
                    beacon_at = now
                time.sleep(0.005)
            if args.leave_running:
                physical = None
                if args.physical_button:
                    physical = {'gpio_trigger': False, 'acknowledged': False,
                                'uart_dtr': port.dtr, 'uart_rts': port.rts}
                    physical_start = refresh_at = time.monotonic()
                    gpio_at = None
                    send('g')
                    record('TEST', 'READY_FOR_PHYSICAL_USER; UART DTR/RTS remain deasserted; no debugger')
                    while time.monotonic() - physical_start < 300:
                        data = port.read(65536)
                        buffers['HC33'] += data.decode(errors='replace')
                        lines = buffers['HC33'].split('\n')
                        buffers['HC33'] = lines.pop()
                        for raw in lines:
                            line = ANSI.sub('', raw).strip()
                            record('HC33', line)
                            if 'USER trigger source=gpio' in line:
                                physical['gpio_trigger'] = True
                                gpio_at = time.monotonic()
                            if gpio_at is not None and 'PAWR_TWT STATS sequence=' in line:
                                physical['acknowledged'] = True
                        if gpio_at is not None and time.monotonic() - gpio_at >= 8:
                            break
                        if time.monotonic() - refresh_at >= 20:
                            send('g')
                            refresh_at = time.monotonic()
                        time.sleep(0.005)
                    record('TEST', 'PHYSICAL_USER_RESULT ' + json.dumps(physical))
                checks = {'all_commands_queued': len(queued_sequences) == sent,
                          'all_commands_acknowledged': sent > 0 and acknowledgements == sent}
                if physical is not None:
                    checks['physical_gpio_and_ack'] = physical['gpio_trigger'] and physical['acknowledged']
                if args.mesh_after_seed is not None:
                    checks['returned_to_mesh_with_same_mac'] = mesh_confirmed
                result = {'mode': args.mode, 'session': session, 'functional_pass': None,
                          'hc33_observation_pass': all(checks.values()), 'checks': checks,
                          'commands': sent, 'hc33_acknowledgements': acknowledgements,
                          'counter_verification': 'skipped to avoid debugger reattachment',
                          'left_running_without_debug_reattach': True, 'normal_boot': True,
                          'debug_power': debug_power, 'mesh_after_seed': args.mesh_after_seed,
                          'mesh_confirmed': mesh_confirmed, 'probe_wiring_connected': True,
                          'physical_button': physical,
                          'rf_sleep_verified': False, 'power_measured': False,
                          'elf': str(args.elf), 'elf_sha256': elf_sha256}
                args.log.with_suffix('.json').write_text(json.dumps(result, indent=2) + '\n')
                record('TEST', 'HANDOFF ' + json.dumps(result))
                return 0 if result['hc33_observation_pass'] else 1
            if detached:
                record('TEST', 'Quiet interval ended; reattach without reset for counters')
                start_server()
            counters = read_counters(table)
            save_snapshot()
            led_out = read_memory(0x50050400, 32, 1)[0]
            led_dir = read_memory(0x50050410, 32, 1)[0]
            checks = assess(session, counters, sent, acknowledgements)
            checks['all_commands_queued'] = len(queued_sequences) == sent
            checks['led_pin_off'] = bool(led_out & 32) and not bool(led_dir & 32)
            reset_reason = read_memory(0x5010e600, 32, 1)[0]
            if args.normal_boot:
                checks['pin_reset_detected'] = bool(reset_reason & 1)
            if args.mesh_after_seed is not None:
                checks['returned_to_mesh_with_same_mac'] = mesh_confirmed
            result = {'mode': args.mode, 'session': session, 'debugger_closed_during_commands': detached,
                      'probe_wiring_connected': True, 'duration_after_active_seconds': args.duration,
                      'snapshot_after_user': args.snapshot_after_user,
                      'mesh_after_seed': args.mesh_after_seed, 'mesh_confirmed': mesh_confirmed,
                      'normal_boot': args.normal_boot, 'debug_power': debug_power,
                      'reset_reason_after_test': reset_reason,
                      'wake_delays': delays, 'commands': sent, 'hc33_acknowledgements': acknowledgements,
                      'queued_sequences': queued_sequences, 'acknowledged_sequences': acknowledged_sequences,
                      'before_detach': pre_detach, 'counters': counters, 'checks': checks,
                      'functional_pass': all(checks.values()), 'rf_sleep_verified': False,
                      'power_measured': False, 'elf': str(args.elf), 'elf_sha256': elf_sha256}
            args.log.with_suffix('.json').write_text(json.dumps(result, indent=2) + '\n')
            record('TEST', 'RESULT ' + json.dumps(result))
            return 0 if result['functional_pass'] else 1
        except Exception as error:
            result = {'mode': args.mode, 'session': session, 'functional_pass': False,
                      'error': str(error), 'commands': sent,
                      'hc33_acknowledgements': acknowledgements,
                      'debugger_closed_during_commands': detached,
                      'normal_boot': args.normal_boot, 'elf': str(args.elf),
                      'rf_sleep_verified': False, 'power_measured': False}
            args.log.with_suffix('.json').write_text(json.dumps(result, indent=2) + '\n')
            record('TEST', 'RESULT ' + json.dumps(result))
            raise
        finally:
            if port.is_open:
                port.close()
            stop_server()


if __name__ == '__main__':
    raise SystemExit(main())
