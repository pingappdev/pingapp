package app.pingapp.android;

import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "DeviceSettings")
public class DeviceSettingsPlugin extends Plugin {
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
        open(intent, call);
    }

    @PluginMethod
    public void openSecuritySettings(PluginCall call) {
        open(new Intent(Settings.ACTION_SECURITY_SETTINGS), call);
    }

    private void open(Intent intent, PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                getActivity().startActivity(intent);
                call.resolve();
            } catch (Exception exception) {
                call.reject("Device settings are not available.", "not_available");
            }
        });
    }
}
