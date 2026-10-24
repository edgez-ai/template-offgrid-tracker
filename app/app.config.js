const appwriteConfig = require("../appwrite.config.json");
const edgezProject = require("../edgez.json");
const profileTable = appwriteConfig.tables?.find((table) => table.$id === "profiles");
const sensorSampleTable = appwriteConfig.tables?.find((table) => table.$id === "sensor-samples");
const databaseId = profileTable?.databaseId || "offgrid-tracker";
const profileTableId = profileTable?.$id || "profiles";

const appName = process.env.APP_NAME || edgezProject.name;
const domainSuffix = process.env.DOMAIN_SUFFIX || "edgez.ai";
const configuredEndpoint = process.env.APPWRITE_PUBLIC_ENDPOINT || process.env.APPWRITE_ENDPOINT || appwriteConfig.endpoint;
const configuredProjectId = process.env.APPWRITE_PROJECT_ID ||
  (appwriteConfig.projectId !== "<PROJECT_ID>" ? appwriteConfig.projectId : "");
const endpointUrl = new URL(configuredEndpoint);
const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
if (endpointUrl.protocol === "http:" && !localHosts.has(endpointUrl.hostname)) endpointUrl.protocol = "https:";
const appwriteEndpoint = endpointUrl.toString().replace(/\/$/, "");
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
      "expo-sqlite",
      "@edgez/react-native-sdk",
      "./plugins/withOrganicMaps",
      ["./plugins/withEdgezBundleUpdates", { runtimeVersion: bundleRuntimeVersion }],
      "./plugins/withUnsignedRelease",
    ],
    android: { package: platform },
    extra: {
      appwriteEndpoint,
      appwriteProjectId: configuredProjectId,
      appwritePlatform: platform,
      appwriteDatabaseId: databaseId,
      appwriteProfileTableId: profileTableId,
      appwriteSensorSampleTableId: sensorSampleTable?.$id || "sensor-samples",
      otaRepositoryUrl: vcsRepositoryUrl.replace(/\.git$/, "").replace(/\/$/, ""),
      otaProxyUrl,
      bundleRuntimeVersion,
    },
  },
};
