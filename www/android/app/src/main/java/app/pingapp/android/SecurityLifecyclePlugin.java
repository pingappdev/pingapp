package app.pingapp.android;

import android.app.Activity;
import android.app.Application;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Treat the plugin's authentication activity as part of the app. */
@CapacitorPlugin(name = "SecurityLifecycle")
public class SecurityLifecyclePlugin extends Plugin implements Application.ActivityLifecycleCallbacks {
    private final java.util.Set<Activity> started = new java.util.HashSet<>();
    private boolean foreground = true;

    @Override public void load() {
        getActivity().getApplication().registerActivityLifecycleCallbacks(this);
    }
    @Override protected void handleOnDestroy() {
        getActivity().getApplication().unregisterActivityLifecycleCallbacks(this);
    }
    @Override public void onActivityStarted(Activity activity) {
        started.add(activity);
        if (!foreground) {
            foreground = true;
            notifyListeners("resume", new com.getcapacitor.JSObject());
        }
    }
    @Override public void onActivityStopped(Activity activity) {
        started.remove(activity);
        // Android starts the next activity before stopping the previous one.
        // An authentication activity therefore keeps this count above zero.
        if (started.isEmpty() && foreground) {
            foreground = false;
            notifyListeners("pause", new com.getcapacitor.JSObject());
        }
    }
    @PluginMethod public void clearCopiedText(PluginCall call) {
        final String expected = call.getString("expected");
        if (expected == null) { call.reject("Clipboard value is required"); return; }
        getActivity().runOnUiThread(() -> {
            ClipboardManager clipboard = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = clipboard.getPrimaryClip();
            // Compare and clear within one UI-thread operation. A replacement
            // cannot be erased between two asynchronous bridge requests.
            if (clip != null && clip.getItemCount() == 1 && expected.contentEquals(clip.getItemAt(0).getText() == null ? "" : clip.getItemAt(0).getText())) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) clipboard.clearPrimaryClip();
                else clipboard.setPrimaryClip(ClipData.newPlainText("", ""));
            }
            call.resolve();
        });
    }
    @Override public void onActivityCreated(Activity activity, Bundle state) {}
    @Override public void onActivityResumed(Activity activity) {}
    @Override public void onActivityPaused(Activity activity) {}
    @Override public void onActivitySaveInstanceState(Activity activity, Bundle state) {}
    @Override public void onActivityDestroyed(Activity activity) {}
}
