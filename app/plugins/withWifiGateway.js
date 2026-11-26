const { withMainApplication, withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

module.exports = function withWifiGateway(config) {
  config = withMainApplication(config, (application) => {
    if (application.modResults.language !== 'kt') throw new Error('Wi-Fi gateway requires a Kotlin MainApplication');
    let contents = application.modResults.contents;
    if (!contents.includes('add(WifiGatewayPackage())')) {
      const anchor = 'PackageList(this).packages.apply {';
      if (!contents.includes(anchor)) throw new Error('Cannot register the Wi-Fi gateway module');
      contents = contents.replace(anchor, `${anchor}\n          add(WifiGatewayPackage())`);
    }
    application.modResults.contents = contents;
    return application;
  });
  return withDangerousMod(config, ['android', async (android) => {
    const packageName = android.android.package;
    const destination = path.join(android.modRequest.platformProjectRoot, 'app/src/main/java', ...packageName.split('.'));
    fs.mkdirSync(destination, { recursive: true });
    for (const name of ['WifiGatewayModule', 'WifiGatewayPackage']) {
      const template = fs.readFileSync(path.join(__dirname, 'android', `${name}.kt.template`), 'utf8');
      fs.writeFileSync(path.join(destination, `${name}.kt`), template.replace('__PACKAGE__', packageName));
    }
    return android;
  }]);
};
