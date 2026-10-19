package io.github.syhuinc.eightd;

import android.annotation.TargetApi;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.media.audiofx.AudioEffect;
import android.media.audiofx.DynamicsProcessing;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Live 8D for other apps.
 *
 * Music apps announce their audio session so equaliser apps can process it
 * (AudioEffect.ACTION_OPEN_AUDIO_EFFECT_CONTROL_SESSION). We attach Android's
 * DynamicsProcessing effect to each announced session and animate it: the far
 * ear gets quieter and slightly muffled (head shadow), and sound behind the
 * listener gets duller. Nothing is captured or re-played, so there is no extra
 * latency and no permission beyond MODIFY_AUDIO_SETTINGS.
 *
 * Limits: the effect works per ear, so it can't move sound from one ear to the
 * other (a hard-left instrument fades rather than travels), and it can't keep
 * vocals centred. Apps that never announce their session are not reached.
 */
@TargetApi(28) // DynamicsProcessing
public class LiveService extends Service {
    static final String TAG = "8DLIVE";
    static final String ACTION_STOP = "io.github.syhuinc.eightd.live.STOP";
    private static final int NOTIFICATION_ID = 8;
    private static final int PRIORITY = 1000; // above typical equaliser apps, so our changes take effect
    private static final long FRAME_MS = 40;  // 25 updates per second
    private static final float SPLIT_HZ = 3000f; // treble band (head shadow, front/back) starts here

    private static volatile LiveService instance;

    private final Map<Integer, Attached> sessions = new LinkedHashMap<>();
    private Handler main;
    private long startedAt;
    private long settingsReadAt;
    private double period = 8;  // seconds per circle, from the shared settings
    private double depth = 1;   // effect strength 0..1
    private int frames;
    private boolean debugLog; // per-second effect diagnostics, debug builds only

    private static final class Attached {
        final String packageName;
        final DynamicsProcessing effect;

        Attached(String packageName, DynamicsProcessing effect) {
            this.packageName = packageName;
            this.effect = effect;
        }
    }

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            int session = intent.getIntExtra(AudioEffect.EXTRA_AUDIO_SESSION, AudioEffect.ERROR);
            String pkg = intent.getStringExtra(AudioEffect.EXTRA_PACKAGE_NAME);
            if (session <= 0) return;
            if (AudioEffect.ACTION_OPEN_AUDIO_EFFECT_CONTROL_SESSION.equals(intent.getAction())) attach(session, pkg);
            else detach(session);
        }
    };

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        main = new Handler(Looper.getMainLooper());
        debugLog = (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, buildNotification());
        }
        IntentFilter filter = new IntentFilter();
        filter.addAction(AudioEffect.ACTION_OPEN_AUDIO_EFFECT_CONTROL_SESSION);
        filter.addAction(AudioEffect.ACTION_CLOSE_AUDIO_EFFECT_CONTROL_SESSION);
        // Exported: these broadcasts come from other apps. Older Android ignores the flag.
        registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
        startedAt = System.nanoTime();
        main.post(this::frame);
        Log.i(TAG, "live started");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) stopSelf();
        return START_NOT_STICKY;
    }

    private void attach(int session, String pkg) {
        if (sessions.containsKey(session)) return;
        try {
            DynamicsProcessing.Eq eq = new DynamicsProcessing.Eq(true, true, 2);
            eq.setBand(0, new DynamicsProcessing.EqBand(true, SPLIT_HZ, 0f));
            eq.setBand(1, new DynamicsProcessing.EqBand(true, 20000f, 0f));
            DynamicsProcessing.Config config = new DynamicsProcessing.Config.Builder(
                    DynamicsProcessing.VARIANT_FAVOR_FREQUENCY_RESOLUTION, 2,
                    true, 2, false, 0, false, 0, false)
                    .setPreEqAllChannelsTo(eq)
                    .build();
            DynamicsProcessing effect = new DynamicsProcessing(PRIORITY, session, config);
            effect.setEnabled(true);
            sessions.put(session, new Attached(pkg, effect));
            Log.i(TAG, "attached to session " + session + " (" + pkg + ")");
        } catch (RuntimeException e) {
            Log.w(TAG, "could not attach to session " + session + " (" + pkg + "): " + e);
        }
    }

    private void detach(int session) {
        Attached a = sessions.remove(session);
        if (a == null) return;
        a.effect.release();
        Log.i(TAG, "detached from session " + session);
    }

    /** One animation step: place the sound on the circle for the current time. */
    private void frame() {
        if (instance != this) return;
        long now = System.nanoTime();
        if (now - settingsReadAt > 2_000_000_000L) readSettings(now);
        double angle = 2 * Math.PI * ((now - startedAt) / 1e9) / period; // 0 = front, then right, back, left
        double x = Math.sin(angle);  // +1 right, -1 left
        double z = Math.cos(angle);  // +1 front, -1 back
        float ild = (float) (16 * depth);   // level difference at the sides (dB)
        float shadow = (float) (9 * depth); // treble cut in the far ear at the sides (dB)
        float back = (float) (6 * depth * Math.max(0, -z)); // duller behind the head
        float leftGain = (float) (-ild * Math.max(0, x)), rightGain = (float) (-ild * Math.max(0, -x));
        float leftTreble = (float) (-shadow * Math.max(0, x)) - back;
        float rightTreble = (float) (-shadow * Math.max(0, -x)) - back;
        for (Integer session : sessions.keySet().toArray(new Integer[0])) {
            DynamicsProcessing dp = sessions.get(session).effect;
            try {
                dp.setInputGainbyChannel(0, leftGain);
                dp.setInputGainbyChannel(1, rightGain);
                dp.setPreEqBandByChannelIndex(0, 1, new DynamicsProcessing.EqBand(true, 20000f, leftTreble));
                dp.setPreEqBandByChannelIndex(1, 1, new DynamicsProcessing.EqBand(true, 20000f, rightTreble));
                if (debugLog && frames % 25 == 0) {
                    Log.d(TAG, String.format("session %d: control=%b enabled=%b set L=%.1f R=%.1f dB, reads L=%.1f R=%.1f",
                            session, dp.hasControl(), dp.getEnabled(), leftGain, rightGain,
                            dp.getInputGainByChannelIndex(0), dp.getInputGainByChannelIndex(1)));
                }
            } catch (RuntimeException e) { // session ended, or another app took control
                Log.w(TAG, "lost session " + session + ": " + e);
                detach(session);
            }
        }
        frames++;
        main.postDelayed(this::frame, FRAME_MS);
    }

    /** Orbit time and effect strength come from the same saved settings as the converter. */
    private void readSettings(long now) {
        settingsReadAt = now;
        String json = getSharedPreferences("settings", MODE_PRIVATE).getString("json", "");
        try {
            JSONObject s = new JSONObject(json.isEmpty() ? "{}" : json);
            double newPeriod = Math.max(2, Math.min(20, s.optDouble("period", 8)));
            if (newPeriod != period) {
                // Keep the current position when the speed changes, so the sound doesn't jump.
                double elapsed = (now - startedAt) / 1e9;
                startedAt = now - (long) (elapsed / period * newPeriod * 1e9);
                period = newPeriod;
            }
            depth = Math.max(0, Math.min(1, s.optDouble("strength", 1)));
        } catch (JSONException ignored) {
        }
    }

    /** For the page: whether live mode is on and which apps it is processing. */
    static String statusJson() {
        LiveService s = instance;
        JSONObject o = new JSONObject();
        JSONArray apps = new JSONArray();
        try {
            o.put("running", s != null);
            if (s != null) {
                for (Attached a : s.sessions.values()) apps.put(a.packageName == null ? "" : a.packageName);
            }
            o.put("apps", apps);
        } catch (JSONException ignored) {
        }
        return o.toString();
    }

    private Notification buildNotification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("live", "Live 8D", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1,
                new Intent(this, LiveService.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, "live")
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle("Live 8D is on")
                .setContentText("Music apps you play now get the 8D effect")
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder(null, "Stop", stop).build())
                .setOngoing(true)
                .build();
    }

    @Override
    public void onDestroy() {
        instance = null;
        main.removeCallbacksAndMessages(null);
        unregisterReceiver(receiver);
        for (Attached a : sessions.values()) a.effect.release(); // music sounds normal again
        sessions.clear();
        Log.i(TAG, "live stopped");
        super.onDestroy();
    }
}
