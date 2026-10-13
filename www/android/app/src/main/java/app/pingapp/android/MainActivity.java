package app.pingapp.android;

import android.os.Bundle;
import android.content.Intent;
import android.net.Uri;
import android.view.WindowManager;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String SAVED_LINK = "pingapp.currentAppUrl";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // ActivityManager retains the task's original VIEW intent, even after
        // setIntent acknowledges it. Restore our latest URI (including null)
        // before Bridge snapshots it for App.getLaunchUrl and appUrlOpen.
        Intent intent = withoutHistoryUrl(getIntent());
        if (intent != null && savedInstanceState != null && savedInstanceState.containsKey(SAVED_LINK)) {
            intent = new Intent(intent);
            String url = savedInstanceState.getString(SAVED_LINK);
            intent.setData(url == null ? null : Uri.parse(url));
        }
        setIntent(intent);
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
    public void onSaveInstanceState(Bundle outState) {
        Intent intent = getIntent();
        outState.putString(SAVED_LINK, intent == null ? null : intent.getDataString());
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        intent = withoutHistoryUrl(intent);
        // A genuine new delivery remains eligible even for the same URL.
        // BridgeActivity also calls this with our restored intent during load.
        if (intent != null) setIntent(intent);
        super.onNewIntent(intent);
    }

    private Intent withoutHistoryUrl(Intent intent) {
        if (intent == null || (intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0) {
            return intent;
        }
        Intent history = new Intent(intent);
        history.setData(null);
        return history;
    }
}
