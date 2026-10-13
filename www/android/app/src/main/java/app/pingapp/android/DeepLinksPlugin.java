package app.pingapp.android;

import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "DeepLinks")
public class DeepLinksPlugin extends Plugin {
    @PluginMethod
    public void configuration(PluginCall call) {
        JSObject result = new JSObject();
        result.put("host", BuildConfig.APP_LINKS_HOST);
        result.put("scheme", BuildConfig.APP_LINK_SCHEME);
        call.resolve(result);
    }

    @PluginMethod
    public void acknowledge(PluginCall call) {
        String expected = call.getString("url");
        getActivity().runOnUiThread(() -> {
            Intent current = getActivity().getIntent();
            if (expected != null && current != null && expected.equals(current.getDataString())) {
                Intent cleared = new Intent(current);
                cleared.setData(null);
                getActivity().setIntent(cleared);
            }
            call.resolve();
        });
    }
}
