package app.pingapp.android;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DeviceSettingsPlugin.class);
        registerPlugin(SecurityLifecyclePlugin.class);
        super.onCreate(savedInstanceState);
        if (BuildConfig.FLAVOR.equals("prod")) {
            getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        }
    }
}
