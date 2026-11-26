const { withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

const marker = "// Offgrid GATT cache recovery (SDK 0.1.35)";

function patchGattRecovery(source) {
  if (source.includes(marker)) return source;
  function replace(before, after) {
    if (source.split(before).length !== 2) throw new Error("SDK BLE implementation changed; review GATT recovery patch");
    source = source.replace(before, after);
  }
  replace("    private val callback = object : BluetoothGattCallback() {", `    ${marker}
    @SuppressLint("MissingPermission")
    private fun failBleSetup(active: BluetoothGatt, reason: String) {
        if (active !== gatt) return
        emit(mapOf("type" to "log", "log" to reason))
        closeGatt()
        emit(mapOf("type" to "connection", "connection" to "none"))
    }

    @SuppressLint("MissingPermission")
    private fun startFreshGattSetup(active: BluetoothGatt) {
        // Match the cache refresh used by the provisioning transport. Firmware
        // updates can move FFF1/FFF2 while Android retains their old handles.
        val refreshed = runCatching {
            active.javaClass.getMethod("refresh").invoke(active) as? Boolean ?: false
        }.getOrDefault(false)
        emit(mapOf("type" to "log", "log" to "BLE GATT cache refresh=$refreshed"))
        Handler(Looper.getMainLooper()).postDelayed({
            if (active === gatt && !active.requestMtu(517) && !active.discoverServices()) {
                failBleSetup(active, "BLE service discovery could not start")
            }
        }, if (refreshed) 1000L else 0L)
    }

    private val callback = object : BluetoothGattCallback() {`);
  replace('            emit(mapOf("type" to "log", "log" to "BLE connection status=$status state=$newState"))',
    '            if (active !== gatt) return\n            emit(mapOf("type" to "log", "log" to "BLE connection status=$status state=$newState"))');
  replace('active.requestMtu(517) }', 'startFreshGattSetup(active) }');
  replace('override fun onMtuChanged(active: BluetoothGatt, mtu: Int, status: Int) { if (status == BluetoothGatt.GATT_SUCCESS) negotiatedMtu = mtu; active.discoverServices() }',
    'override fun onMtuChanged(active: BluetoothGatt, mtu: Int, status: Int) { if (active !== gatt) return; if (status == BluetoothGatt.GATT_SUCCESS) negotiatedMtu = mtu; if (!active.discoverServices()) failBleSetup(active, "BLE service discovery could not start") }');
  replace('            if (status != BluetoothGatt.GATT_SUCCESS) { emit(mapOf("type" to "log", "log" to "BLE service discovery failed=$status")); return }',
    '            if (active !== gatt) return\n            if (status != BluetoothGatt.GATT_SUCCESS) { failBleSetup(active, "BLE service discovery failed=$status"); return }');
  replace('            val service = active.getService(SERVICE) ?: run { emit(mapOf("type" to "log", "log" to "EdgeZ BLE service is missing")); return }',
    '            val service = active.getService(SERVICE) ?: run { failBleSetup(active, "EdgeZ BLE service is missing"); return }');
  replace('            rx = service.getCharacteristic(RX); tx = service.getCharacteristic(TX); ota = service.getCharacteristic(OTA)',
    `            rx = service.getCharacteristic(RX); tx = service.getCharacteristic(TX); ota = service.getCharacteristic(OTA)
            if (rx == null || tx?.getDescriptor(CCCD) == null) {
                failBleSetup(active, "EdgeZ BLE control characteristics or notification descriptor are missing"); return
            }`);
  replace('                active.setCharacteristicNotification(characteristic, true); characteristic.getDescriptor(CCCD)?.let(descriptorQueue::add)',
    '                if (!active.setCharacteristicNotification(characteristic, true)) { failBleSetup(active, "BLE notification setup failed"); return }\n                characteristic.getDescriptor(CCCD)?.let(descriptorQueue::add)');
  replace('override fun onDescriptorWrite(active: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) { writeNextDescriptor(active) }',
    `override fun onDescriptorWrite(active: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            if (active !== gatt) return
            if (status != BluetoothGatt.GATT_SUCCESS) { failBleSetup(active, "BLE notification subscription failed=$status"); return }
            writeNextDescriptor(active)
        }`);
  replace('        if (Build.VERSION.SDK_INT >= 33) active.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)\n        else { descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE; active.writeDescriptor(descriptor) }',
    `        val queued = if (Build.VERSION.SDK_INT >= 33) {
            active.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == BluetoothStatusCodes.SUCCESS
        } else {
            descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            active.writeDescriptor(descriptor)
        }
        if (!queued) failBleSetup(active, "BLE notification subscription could not start")`);
  replace('        descriptorQueue.clear(); rx = null; tx = null; ota = null',
    '        descriptorQueue.clear(); rx = null; tx = null; ota = null; negotiatedMtu = 23');
  return source;
}

module.exports = function withBleGattRecovery(config) {
  return withDangerousMod(config, ["android", async (android) => {
    const sdk = path.dirname(require.resolve("@edgez/react-native-sdk/package.json", { paths: [android.modRequest.projectRoot] }));
    const file = path.join(sdk, "android/src/main/java/ai/edgez/react_native_sdk/EdgezReactNativeSdkModule.kt");
    const original = fs.readFileSync(file, "utf8");
    const patched = patchGattRecovery(original);
    if (patched !== original) fs.writeFileSync(file, patched);
    return android;
  }]);
};
module.exports.patchGattRecovery = patchGattRecovery;
