import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.pingapp.android",
  appName: "PingApp",
  webDir: "dist-native",
  // SecureStorage bridge arguments/results contain keys and bearer tokens.
  // Disable Capacitor's automatic native/JS bridge logging in every flavor.
  loggingBehavior: "none",
  server: { androidScheme: "https" },
  android: { allowMixedContent: process.env.CAP_ALLOW_MIXED === "1" },
  plugins: {
    SplashScreen: { launchShowDuration: 500, backgroundColor: "#08080C", showSpinner: false },
    SystemBars: { style: "DARK" },
    StatusBar: { style: "DARK", backgroundColor: "#08080C", overlaysWebView: false },
    Keyboard: { resize: "body", resizeOnFullScreen: true },
  },
};

export default config;
