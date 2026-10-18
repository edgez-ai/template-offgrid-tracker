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
import { authenticateCloud, cloudAuthConfigured, cloudErrorMessage } from "./cloud-auth";

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
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) return;
    setPassword("");
    setPasswordVisible(false);
    setError("");
  }, [visible]);

  const authenticate = async (register: boolean) => {
    if (!email.trim() || !password) {
      setError("Enter an email address and password.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await authenticateCloud(email.trim(), password, register);
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
              Sign in to connect this profile to EdgeZ Cloud. Offline mesh features remain available without a session.
            </Text>
            <Text style={loginStyles.label}>EMAIL</Text>
            <TextInput
              style={loginStyles.input}
              value={email}
              onChangeText={setEmail}
              placeholder="Email"
              placeholderTextColor="#718a83"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              editable={!busy}
            />
            <Text style={loginStyles.label}>PASSWORD</Text>
            <View style={loginStyles.passwordField}>
              <TextInput
                style={loginStyles.passwordInput}
                value={password}
                onChangeText={setPassword}
                placeholder="Password"
                placeholderTextColor="#718a83"
                secureTextEntry={!passwordVisible}
                autoCapitalize="none"
                editable={!busy}
                onSubmitEditing={() => void authenticate(false)}
              />
              <Pressable
                style={loginStyles.eyeButton}
                onPress={() => setPasswordVisible((current) => !current)}
                accessibilityRole="button"
                accessibilityLabel={passwordVisible ? "Hide password" : "Show password"}
              >
                <Ionicons name={passwordVisible ? "eye-outline" : "eye-off-outline"} size={23} color="#59716f" />
              </Pressable>
            </View>
            {!cloudAuthConfigured ? (
              <Text style={loginStyles.error}>Cloud login is not configured in this app build.</Text>
            ) : error ? <Text style={loginStyles.error}>{error}</Text> : null}
            <Pressable
              style={[loginStyles.primary, (busy || !cloudAuthConfigured) && loginStyles.disabled]}
              onPress={() => void authenticate(false)}
              disabled={busy || !cloudAuthConfigured}
              accessibilityRole="button"
            >
              {busy ? <ActivityIndicator color="white" /> : <Text style={loginStyles.primaryText}>SIGN IN</Text>}
            </Pressable>
            <Pressable
              style={[loginStyles.secondary, (busy || !cloudAuthConfigured) && loginStyles.disabled]}
              onPress={() => void authenticate(true)}
              disabled={busy || !cloudAuthConfigured}
              accessibilityRole="button"
            >
              <Text style={loginStyles.secondaryText}>CREATE ACCOUNT</Text>
            </Pressable>
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
  passwordField: { height: 54, borderWidth: 1, borderColor: "#cedbdc", borderRadius: 12, backgroundColor: "white", flexDirection: "row", alignItems: "center" },
  passwordInput: { flex: 1, height: 52, paddingLeft: 15, color: "#0a3037", fontSize: 14 },
  eyeButton: { width: 54, height: 52, alignItems: "center", justifyContent: "center" },
  error: { color: "#b9472f", fontSize: 11, lineHeight: 16, textAlign: "center", marginTop: 12 },
  primary: { minHeight: 52, marginTop: 18, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "#0a8c87" },
  primaryText: { color: "white", fontSize: 10, fontWeight: "900", letterSpacing: 0.8 },
  secondary: { minHeight: 46, alignItems: "center", justifyContent: "center" },
  secondaryText: { color: "#0a8c87", fontSize: 10, fontWeight: "900", letterSpacing: 0.8 },
  disabled: { opacity: 0.5 },
});
