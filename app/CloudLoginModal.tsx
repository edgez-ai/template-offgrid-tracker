import Ionicons from "@expo/vector-icons/Ionicons";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  cloudAuthConfigured,
  cloudErrorMessage,
  completeCloudToken,
  requestCloudEmailOtp,
} from "./cloud-auth";

export function CloudLoginModal({
  visible,
  onClose,
  onAuthenticated,
}: {
  visible: boolean;
  onClose: () => void;
  onAuthenticated: () => void;
}) {
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [otpUserId, setOtpUserId] = useState("");
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const resetRequest = () => {
    setOtp("");
    setOtpUserId("");
    setPhrase("");
    setError("");
  };

  useEffect(() => {
    if (!visible) return;
    setOtp("");
    setOtpUserId("");
    setPhrase("");
    setError("");
  }, [visible]);

  const sendEmailOtp = async () => {
    if (!email.trim()) {
      setError("Enter your email address.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const request = await requestCloudEmailOtp(email.trim());
      setOtpUserId(request.userId);
      setPhrase(request.phrase);
    } catch (caught) {
      setError(cloudErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const verifyEmailOtp = async () => {
    if (!otpUserId || !otp.trim()) {
      setError("Enter the one-time code from your email.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await completeCloudToken(otpUserId, otp.trim());
      onAuthenticated();
      onClose();
    } catch (caught) {
      setError(cloudErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={loginStyles.backdrop}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <SafeAreaView style={loginStyles.safeArea}>
          <Pressable style={StyleSheet.absoluteFill} onPress={busy ? undefined : onClose} />
          <View style={loginStyles.card}>
            <View style={loginStyles.header}>
              <View>
                <Text style={loginStyles.eyebrow}>EDGEZ CLOUD</Text>
                <Text style={loginStyles.title}>Sign in</Text>
              </View>
              <Pressable
                style={loginStyles.closeButton}
                onPress={onClose}
                disabled={busy}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Close cloud login"
              >
                <Ionicons name="close" size={25} color="#59716f" />
              </Pressable>
            </View>

            <Text style={loginStyles.help}>
              Enter your email to receive a one-time code. A new account is created automatically when needed.
            </Text>

            <Text style={loginStyles.label}>EMAIL</Text>
            <TextInput
              style={loginStyles.input}
              value={email}
              onChangeText={(value) => { setEmail(value); resetRequest(); }}
              placeholder="you@example.com"
              placeholderTextColor="#718a83"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              editable={!busy && !otpUserId}
              onSubmitEditing={() => void sendEmailOtp()}
            />

            {otpUserId ? (
              <>
                <Text style={loginStyles.label}>ONE-TIME CODE</Text>
                <TextInput
                  style={loginStyles.otpInput}
                  value={otp}
                  onChangeText={setOtp}
                  placeholder="000000"
                  placeholderTextColor="#718a83"
                  keyboardType="number-pad"
                  autoComplete="one-time-code"
                  textContentType="oneTimeCode"
                  editable={!busy}
                  maxLength={16}
                  onSubmitEditing={() => void verifyEmailOtp()}
                />
              </>
            ) : null}

            {phrase ? (
              <View style={loginStyles.phraseCard}>
                <Text style={loginStyles.phraseLabel}>SECURITY PHRASE</Text>
                <Text style={loginStyles.phrase}>{phrase}</Text>
                <Text style={loginStyles.phraseHelp}>Confirm this phrase matches the email before continuing.</Text>
              </View>
            ) : null}

            {!cloudAuthConfigured ? (
              <Text style={loginStyles.error}>Cloud login is not configured in this app build.</Text>
            ) : error ? <Text style={loginStyles.error}>{error}</Text> : null}

            <Pressable
              style={[loginStyles.primary, (busy || !cloudAuthConfigured) && loginStyles.disabled]}
              onPress={() => void (otpUserId ? verifyEmailOtp() : sendEmailOtp())}
              disabled={busy || !cloudAuthConfigured}
              accessibilityRole="button"
            >
              {busy ? <ActivityIndicator color="white" /> : (
                <Text style={loginStyles.primaryText}>
                  {otpUserId ? "VERIFY CODE" : "SEND EMAIL CODE"}
                </Text>
              )}
            </Pressable>

            {otpUserId ? (
              <Pressable style={loginStyles.secondary} onPress={resetRequest} disabled={busy}>
                <Text style={loginStyles.secondaryText}>USE A DIFFERENT EMAIL</Text>
              </Pressable>
            ) : null}
          </View>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const loginStyles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(4, 25, 30, 0.62)" },
  safeArea: { flex: 1, paddingHorizontal: 22, justifyContent: "center" },
  card: { padding: 22, borderRadius: 20, backgroundColor: "#f7faf9", elevation: 8, shadowColor: "#000", shadowOpacity: 0.28, shadowRadius: 12, shadowOffset: { width: 0, height: 5 } },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  eyebrow: { color: "#0a8c87", fontSize: 9, fontWeight: "900", letterSpacing: 1 },
  title: { color: "#0a3037", fontSize: 28, fontWeight: "900", marginTop: 3 },
  closeButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 22, backgroundColor: "#e9f1ef" },
  help: { color: "#59716f", fontSize: 12, lineHeight: 18, marginTop: 14, marginBottom: 5 },
  label: { color: "#59716f", fontSize: 9, fontWeight: "900", letterSpacing: 0.8, marginTop: 14, marginBottom: 7 },
  input: { height: 54, paddingHorizontal: 15, borderWidth: 1, borderColor: "#cedbdc", borderRadius: 12, color: "#0a3037", backgroundColor: "white", fontSize: 14 },
  otpInput: { height: 58, paddingHorizontal: 15, borderWidth: 1, borderColor: "#9fc9c4", borderRadius: 12, color: "#0a3037", backgroundColor: "white", fontSize: 22, fontWeight: "800", letterSpacing: 5, textAlign: "center" },
  phraseCard: { marginTop: 14, padding: 12, borderRadius: 11, backgroundColor: "#e9f3f1", alignItems: "center" },
  phraseLabel: { color: "#59716f", fontSize: 8, fontWeight: "900", letterSpacing: 0.8 },
  phrase: { color: "#0a3037", fontSize: 16, fontWeight: "900", marginTop: 4 },
  phraseHelp: { color: "#59716f", fontSize: 10, lineHeight: 14, marginTop: 4, textAlign: "center" },
  error: { color: "#b9472f", fontSize: 11, lineHeight: 16, textAlign: "center", marginTop: 12 },
  primary: { minHeight: 52, marginTop: 18, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "#0a8c87" },
  primaryText: { color: "white", fontSize: 10, fontWeight: "900", letterSpacing: 0.8 },
  secondary: { minHeight: 46, alignItems: "center", justifyContent: "center" },
  secondaryText: { color: "#0a8c87", fontSize: 10, fontWeight: "900", letterSpacing: 0.8 },
  disabled: { opacity: 0.5 },
});
