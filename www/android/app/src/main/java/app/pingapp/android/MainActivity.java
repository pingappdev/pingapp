package app.pingapp.android;

import android.os.Bundle;
import android.content.Intent;
import android.view.WindowManager;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DeviceSettingsPlugin.class);
        registerPlugin(SecurityLifecyclePlugin.class);
        registerPlugin(DeepLinksPlugin.class);
        super.onCreate(savedInstanceState);
        if (BuildConfig.FLAVOR.equals("prod")) {
            WebView.setWebContentsDebuggingEnabled(false);
            getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        // Keep the current task's intent in sync so an acknowledged URL cannot
        // reappear after process death. Capacitor still delivers appUrlOpen.
        if (intent != null) setIntent(intent);
        super.onNewIntent(intent);
    }
}
