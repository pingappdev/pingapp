import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'app.pingapp.android',
  appName: 'PingApp',
  webDir: 'dist-native',
  server: { androidScheme: 'https' },
  android: { allowMixedContent: process.env.CAP_ALLOW_MIXED === '1' },
  plugins: {
    SplashScreen: { launchShowDuration: 500, backgroundColor: '#14151C', showSpinner: false },
    StatusBar: { style: 'DARK', backgroundColor: '#14151C' },
    Keyboard: { resize: 'body' },
  },
}

export default config
