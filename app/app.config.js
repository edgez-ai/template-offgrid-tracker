const edgezProject = require("../edgez.json");

const appName = process.env.APP_NAME || edgezProject.name;
const domainSuffix = process.env.DOMAIN_SUFFIX || "edgez.ai";
const bundlePrefix = domainSuffix.split(".").reverse().join(".");
const androidName = appName.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z_]+/, "app");
const platform = `${bundlePrefix}.${androidName}`;
const vcsRepositoryUrl = process.env.OFFGRID_TRACKER_REPOSITORY_URL ||
  (process.env.GITHUB_REPOSITORY
    ? `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${process.env.GITHUB_REPOSITORY}`
    : "");
const bundleRuntimeVersion = process.env.EDGEZ_BUNDLE_RUNTIME_VERSION || "offgrid-tracker-android-2";
const otaProxyUrl = process.env.EDGEZ_OTA_PROXY_URL || "https://github.edgez.biz";

module.exports = {
  expo: {
    name: appName,
    slug: appName,
    scheme: "edgez-devtools",
    version: "1.0.0",
    orientation: "portrait",
    userInterfaceStyle: "light",
    plugins: [
      "expo-status-bar",
      "@edgez/react-native-sdk",
      "./plugins/withOrganicMaps",
      ["./plugins/withEdgezBundleUpdates", { runtimeVersion: bundleRuntimeVersion }],
      "./plugins/withUnsignedRelease",
    ],
    android: { package: platform },
    extra: {
      otaRepositoryUrl: vcsRepositoryUrl.replace(/\.git$/, "").replace(/\/$/, ""),
      otaProxyUrl,
      bundleRuntimeVersion,
    },
  },
};
