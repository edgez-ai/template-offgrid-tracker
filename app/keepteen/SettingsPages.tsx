import Constants from "expo-constants";
import React, { useEffect, useState } from "react";
import { Image, Linking, StyleSheet, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { bandwidthForChannel, channelsForCountry } from "../halowChannels";
import { cloudAuthConfigured, cloudErrorMessage, completeCloudToken, requestCloudEmailOtp } from "../cloud-auth";
import { artwork } from "./assets";
import { languages, useI18n } from "./i18n";
import type { MessageKey } from "./i18n";
import { useTheme } from "./theme";
import type { AppearancePreference } from "./theme";
import type { KeepteenActions, KeepteenRuntime } from "./types";
import { Button, Card, Field, InfoLine, ListRow, NavHeader, Notice, PageScroll, Screen, Segmented, SwitchRow } from "./ui";
import type { IconName } from "./ui";

export type SettingsPageKey = "account" | "halow" | "notifications" | "general" | "help" | "about";

/** R27: exactly six first-level items. */
export const settingsItems: ReadonlyArray<{ key: SettingsPageKey; icon: IconName; label: MessageKey }> = [
  { key: "account", icon: "person-circle-outline", label: "settingsAccount" },
  { key: "halow", icon: "wifi-outline", label: "settingsHalow" },
  { key: "notifications", icon: "notifications-outline", label: "settingsNotifications" },
  { key: "general", icon: "options-outline", label: "settingsGeneral" },
  { key: "help", icon: "help-circle-outline", label: "settingsHelp" },
  { key: "about", icon: "information-circle-outline", label: "settingsAbout" },
];

export function SettingsHome({ runtime, onOpen }: { runtime: KeepteenRuntime; onOpen: (page: SettingsPageKey) => void }) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const values: Partial<Record<SettingsPageKey, string>> = {
    account: runtime.cloudLoggedIn ? t("signedIn") : t("notSignedIn"),
    halow: runtime.profile.name,
  };
  return (
    <PageScroll>
      <Text style={[styles.bigTitle, { color: colors.text }]} accessibilityRole="header">{t("tabSettings")}</Text>
      <Card>
        {settingsItems.map((item, index) => (
          <ListRow key={item.key} icon={item.icon} title={t(item.label)} value={values[item.key]} onPress={() => onOpen(item.key)} last={index === settingsItems.length - 1} />
        ))}
      </Card>
      {runtime.error ? <Notice tone="danger" text={runtime.error} /> : null}
    </PageScroll>
  );
}

export function SettingsPage({ page, runtime, actions, onBack }: { page: SettingsPageKey; runtime: KeepteenRuntime; actions: KeepteenActions; onBack: () => void }) {
  switch (page) {
    case "account": return <AccountPage runtime={runtime} actions={actions} onBack={onBack} />;
    case "halow": return <HalowPage runtime={runtime} actions={actions} onBack={onBack} />;
    case "notifications": return <NotificationsPage onBack={onBack} />;
    case "general": return <GeneralPage actions={actions} onBack={onBack} />;
    case "help": return <HelpPage onBack={onBack} />;
    default: return <AboutPage onBack={onBack} />;
  }
}

/* Account ---------------------------------------------------------------- */

function AccountPage({ runtime, actions, onBack }: { runtime: KeepteenRuntime; actions: KeepteenActions; onBack: () => void }) {
  const { t } = useI18n();
  const [method, setMethod] = useState<"code" | "password">("code");
  const [resetOpen, setResetOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [userId, setUserId] = useState("");
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");

  // Codes and typed passwords live only in this page's state, so leaving the
  // page discards them; nothing here is persisted.

  if (resetOpen) {
    return (
      <Screen>
        <NavHeader title={t("resetPassword")} onBack={() => setResetOpen(false)} />
        <PageScroll>
          <Notice tone="warning" text={t("passwordServiceUnavailable")} />
          <Button kind="secondary" label={t("useEmailCodeInstead")} onPress={() => { setResetOpen(false); setMethod("code"); }} />
        </PageScroll>
      </Screen>
    );
  }

  const requestCode = async () => {
    if (!email.trim()) { setError(t("enterEmail")); return; }
    setBusy(true); setError("");
    try {
      const request = await requestCloudEmailOtp(email.trim());
      setUserId(request.userId); setPhrase(request.phrase);
    } catch (caught) { setError(cloudErrorMessage(caught)); } finally { setBusy(false); }
  };
  const verify = async () => {
    if (!userId || !code.trim()) { setError(t("enterCode")); return; }
    setBusy(true); setError("");
    try {
      await completeCloudToken(userId, code.trim());
      setCode(""); setUserId(""); setPhrase("");
      actions.cloudAuthenticated();
    } catch (caught) { setError(cloudErrorMessage(caught)); } finally { setBusy(false); }
  };

  return (
    <Screen>
      <NavHeader title={t("settingsAccount")} onBack={onBack} />
      <PageScroll>
        {runtime.cloudLoggedIn ? <>
          <Card>
            <InfoLine label={t("accountStatus")} value={t("signedIn")} />
            <InfoLine label={t("cloudForThisNetwork")} value={runtime.profile.connectToCloud ? t(runtime.cloudStatus === "online" ? "statusCloudOnline" : "statusCloudOffline") : t("cloudOffForNetwork")} last />
          </Card>
          <Notice text={t("logoutKeepsData")} />
          <Button kind="danger" label={t("logOut")} onPress={actions.cloudLogout} loading={runtime.busy} />
        </> : <>
          <Segmented<"code" | "password">
            options={[{ key: "code", label: t("loginWithCode") }, { key: "password", label: t("loginWithPassword") }]}
            value={method}
            onChange={(next) => { setMethod(next); setError(""); }}
          />
          <Field label={t("email")} value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" editable={!busy} />
          {method === "code" ? <>
            {userId ? <>
              {phrase ? <Notice text={t("securityPhrase", { phrase })} /> : null}
              <Field label={t("oneTimeCode")} value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="one-time-code" maxLength={12} />
              <Button label={t("signIn")} onPress={() => void verify()} loading={busy} disabled={!cloudAuthConfigured} />
              <Button kind="secondary" label={t("sendNewCode")} onPress={() => void requestCode()} disabled={busy} />
            </> : <Button label={t("sendCode")} onPress={() => void requestCode()} loading={busy} disabled={!cloudAuthConfigured} />}
            <Notice text={t("codeAccountHint")} />
          </> : <>
            <Field label={t("password")} value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" />
            <Notice tone="warning" text={t("passwordServiceUnavailable")} />
            <Button label={t("signIn")} onPress={() => undefined} disabled />
            <ListRow title={t("forgotPassword")} onPress={() => setResetOpen(true)} last />
          </>}
          {!cloudAuthConfigured ? <Notice tone="warning" text={t("cloudNotConfigured")} /> : null}
          {error ? <Notice tone="danger" text={error} /> : null}
        </>}
      </PageScroll>
    </Screen>
  );
}

/* HaLow ------------------------------------------------------------------ */

function HalowPage({ runtime, actions, onBack }: { runtime: KeepteenRuntime; actions: KeepteenActions; onBack: () => void }) {
  const { t } = useI18n();
  const profile = runtime.profile;
  const channel = channelsForCountry(profile.country).find(({ number }) => number === profile.halowChannel);
  return (
    <Screen>
      <NavHeader title="HaLow" onBack={onBack} />
      <PageScroll>
        <Card>
          <InfoLine label={t("networkName")} value={profile.name} />
          <InfoLine label={t("country")} value={profile.country} />
          <InfoLine label={t("channel")} value={profile.halowChannel === 0 ? t("auto") : String(profile.halowChannel)} />
          <InfoLine label={t("frequency")} value={channel ? `${channel.frequencyMHz} MHz · ${bandwidthForChannel(channel)} MHz` : t("auto")} />
          <InfoLine label="SSID/MESH ID" value={profile.meshId} />
          <InfoLine label={t("networkPassword")} value={profile.meshPassphrase ? t("passwordSet") : t("passwordNone")} />
          <InfoLine label={t("cloud")} value={profile.connectToCloud ? t("on") : t("off")} last />
        </Card>
        <Button label={t("editNetwork")} icon="create-outline" onPress={actions.editProfile} disabled={runtime.busy} />
        <Notice text={t("halowApplyNotice")} />

        <Text style={styles.section}>{t("savedNetworks")}</Text>
        <Card>
          {runtime.profiles.map((item, index) => (
            <ListRow
              key={item.id}
              icon={item.id === profile.id ? "checkmark-circle" : "ellipse-outline"}
              title={item.name}
              subtitle={`${item.country} · ${item.halowChannel === 0 ? t("auto") : t("channelN", { n: item.halowChannel })} · ${item.meshId}`}
              onPress={item.id === profile.id || runtime.busy ? undefined : () => actions.selectProfile(item)}
              last={index === runtime.profiles.length - 1}
            />
          ))}
        </Card>
        <Button kind="secondary" icon="add" label={t("addNetwork")} onPress={actions.createProfile} disabled={runtime.busy} />
        <Button kind="danger" label={t("deleteNetwork")} onPress={actions.deleteProfile} disabled={runtime.busy} />
        {runtime.error ? <Notice tone="danger" text={runtime.error} /> : null}
      </PageScroll>
    </Screen>
  );
}

/* Notifications ---------------------------------------------------------- */

const notificationKey = "keepteen.notifications.v1";
type NotificationPrefs = { messages: boolean; areaReminders: boolean; lowBattery: boolean };

function NotificationsPage({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  const [prefs, setPrefs] = useState<NotificationPrefs>({ messages: true, areaReminders: true, lowBattery: false });
  useEffect(() => {
    void AsyncStorage.getItem(notificationKey).then((stored) => {
      if (stored) setPrefs((current) => ({ ...current, ...JSON.parse(stored) as Partial<NotificationPrefs> }));
    }).catch(() => undefined);
  }, []);
  const update = (patch: Partial<NotificationPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    void AsyncStorage.setItem(notificationKey, JSON.stringify(next)).catch(() => undefined);
  };
  return (
    <Screen>
      <NavHeader title={t("settingsNotifications")} onBack={onBack} />
      <PageScroll>
        <Card>
          <SwitchRow title={t("notifyMessages")} value={prefs.messages} onChange={(messages) => update({ messages })} />
          <SwitchRow title={t("notifyAreaReminders")} value={prefs.areaReminders} onChange={(areaReminders) => update({ areaReminders })} />
          <SwitchRow title={t("notifyLowBattery")} subtitle={t("notifyLowBatteryHint")} value={prefs.lowBattery} onChange={(lowBattery) => update({ lowBattery })} last />
        </Card>
        <Notice text={t("notificationsInAppOnly")} />
      </PageScroll>
    </Screen>
  );
}

/* General ---------------------------------------------------------------- */

function GeneralPage({ actions, onBack }: { actions: KeepteenActions; onBack: () => void }) {
  const { preference, setPreference } = useTheme();
  const { t, language, setLanguage } = useI18n();
  const [languageOpen, setLanguageOpen] = useState(false);
  if (languageOpen) {
    return (
      <Screen>
        <NavHeader title={t("language")} onBack={() => setLanguageOpen(false)} />
        <PageScroll>
          <Card>
            {languages.map((item, index) => (
              <ListRow
                key={item.code}
                icon={item.code === language ? "checkmark-circle" : "ellipse-outline"}
                title={item.nativeName}
                onPress={() => { setLanguage(item.code); setLanguageOpen(false); }}
                last={index === languages.length - 1}
              />
            ))}
          </Card>
          <Notice text={t("languageNotice")} />
        </PageScroll>
      </Screen>
    );
  }
  return (
    <Screen>
      <NavHeader title={t("settingsGeneral")} onBack={onBack} />
      <PageScroll>
        <Text style={styles.section}>{t("appearance")}</Text>
        <Segmented<AppearancePreference>
          options={[{ key: "system", label: t("appearanceSystem") }, { key: "light", label: t("appearanceLight") }, { key: "dark", label: t("appearanceDark") }]}
          value={preference}
          onChange={setPreference}
        />
        <Card>
          <ListRow icon="language-outline" title={t("language")} value={languages.find((item) => item.code === language)?.nativeName} onPress={() => setLanguageOpen(true)} />
          <ListRow icon="map-outline" title={t("offlineMaps")} subtitle={t("offlineMapsHint")} />
          <ListRow icon="navigate-outline" title={t("beaconAndLocation")} subtitle={t("beaconAndLocationHint")} onPress={actions.openAdvancedSettings} last />
        </Card>
      </PageScroll>
    </Screen>
  );
}

/* Help ------------------------------------------------------------------- */

function HelpPage({ onBack }: { onBack: () => void }) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const topics: ReadonlyArray<[MessageKey, MessageKey]> = [
    ["helpAddTitle", "helpAddBody"],
    ["helpCollarTitle", "helpCollarBody"],
    ["helpFenceTitle", "helpFenceBody"],
    ["helpChatTitle", "helpChatBody"],
    ["helpHalowTitle", "helpHalowBody"],
  ];
  return (
    <Screen>
      <NavHeader title={t("settingsHelp")} onBack={onBack} />
      <PageScroll>
        {topics.map(([title, body]) => (
          <Card key={title} style={styles.helpCard}>
            <Text style={[styles.helpTitle, { color: colors.text }]}>{t(title)}</Text>
            <Text style={[styles.helpBody, { color: colors.secondary }]}>{t(body)}</Text>
          </Card>
        ))}
      </PageScroll>
    </Screen>
  );
}

/* About (R32, R33, R35) -------------------------------------------------- */

function AboutPage({ onBack }: { onBack: () => void }) {
  const { colors, mode } = useTheme();
  const { t } = useI18n();
  const version = Constants.expoConfig?.version ?? "—";
  const companies: ReadonlyArray<{ name: string; body: MessageKey; url: string }> = [
    { name: "KEEPTEEN", body: "aboutKeepteen", url: "https://www.keepteen.com" },
    { name: "EdgeZeron AI AB · EdgeZ.ai", body: "aboutEdgez", url: "https://www.edgez.ai" },
  ];
  return (
    <Screen>
      <NavHeader title={t("settingsAbout")} onBack={onBack} />
      <PageScroll>
        <View style={styles.logos}>
          <Image source={artwork(mode, "keepteen")} style={styles.logo} resizeMode="contain" accessibilityLabel="KEEPTEEN" />
          <Text style={[styles.times, { color: colors.secondary }]}>×</Text>
          <Image source={artwork(mode, "edgez")} style={styles.logo} resizeMode="contain" accessibilityLabel="EdgeZ.ai" />
        </View>
        <Text style={[styles.joint, { color: colors.secondary }]}>{t("jointlyBuilt")}</Text>
        {companies.map((company) => (
          <Card key={company.name} style={styles.helpCard}>
            <Text style={[styles.helpTitle, { color: colors.text }]}>{company.name}</Text>
            <Text style={[styles.helpBody, { color: colors.secondary }]}>{t(company.body)}</Text>
            <Text style={[styles.link, { color: colors.accent }]} onPress={() => void Linking.openURL(company.url)} accessibilityRole="link">
              {company.url.replace("https://", "")}
            </Text>
          </Card>
        ))}
        <Card>
          <InfoLine label={t("appVersion")} value={version} last />
        </Card>
      </PageScroll>
    </Screen>
  );
}

const styles = StyleSheet.create({
  bigTitle: { fontSize: 30, fontWeight: "700", marginBottom: 4 },
  section: { fontSize: 13, marginLeft: 4, marginTop: 6, color: "#8E8E93" },
  helpCard: { paddingVertical: 14, gap: 6 },
  helpTitle: { fontSize: 16, fontWeight: "600" },
  helpBody: { fontSize: 14, lineHeight: 20 },
  logos: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 14, marginTop: 16 },
  logo: { width: 120, height: 46 },
  times: { fontSize: 20 },
  joint: { textAlign: "center", fontSize: 13, marginBottom: 8 },
  link: { fontSize: 14, fontWeight: "500", marginTop: 2 },
});
