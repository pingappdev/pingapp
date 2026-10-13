package app.pingapp.android;

import android.app.Activity;
import android.app.Application;
import android.os.Bundle;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Treat the plugin's authentication activity as part of the app. */
@CapacitorPlugin(name = "SecurityLifecycle")
public class SecurityLifecyclePlugin extends Plugin implements Application.ActivityLifecycleCallbacks {
    private int started = 0; // Registered during the bridge activity's onCreate.
    private boolean foreground = true;

    @Override public void load() {
        getActivity().getApplication().registerActivityLifecycleCallbacks(this);
    }
    @Override protected void handleOnDestroy() {
        getActivity().getApplication().unregisterActivityLifecycleCallbacks(this);
    }
    @Override public void onActivityStarted(Activity activity) {
        started++;
        if (!foreground) {
            foreground = true;
            notifyListeners("resume", new com.getcapacitor.JSObject());
        }
    }
    @Override public void onActivityStopped(Activity activity) {
        started = Math.max(0, started - 1);
        // Android starts the next activity before stopping the previous one.
        // An authentication activity therefore keeps this count above zero.
        if (started == 0 && foreground) {
            foreground = false;
            notifyListeners("pause", new com.getcapacitor.JSObject());
        }
    }
    @Override public void onActivityCreated(Activity activity, Bundle state) {}
    @Override public void onActivityResumed(Activity activity) {}
    @Override public void onActivityPaused(Activity activity) {}
    @Override public void onActivitySaveInstanceState(Activity activity, Bundle state) {}
    @Override public void onActivityDestroyed(Activity activity) {}
}
